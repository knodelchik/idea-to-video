import { describe, expect, it } from "vitest";
import {
  compareLine,
  compareWords,
  extractQuotedLines,
  MAX_READINGS,
  nonLatinLetters,
  normalize,
  numberToWords,
  QuoteError,
  splitDelivery,
  wordCount,
} from "../src/verbatim.ts";

describe("normalize", () => {
  it("acceptance 1: apostrophes, dashes, punctuation, digits", () => {
    expect(normalize("Don’t—stop! It's 3 o'clock.")).toBe("don't stop it's three o'clock");
  });

  it("unifies all apostrophe variants and keeps only intra-word ones", () => {
    expect(normalize("Iʼm ‘here’, they're 'quoted'")).toBe("i'm here they're quoted");
  });

  it("turns hyphens and dashes into spaces", () => {
    expect(normalize("well-known – really — yes")).toBe("well known really yes");
  });

  it("applies NFKC and collapses whitespace", () => {
    expect(normalize("  ﬁne\t\n  ＡＢＣ  ")).toBe("fine abc");
  });

  it("drops quotes and other punctuation", () => {
    expect(normalize("“Meet me,” she said; «now?»")).toBe("meet me she said now");
  });

  it("spells numbers 0–999 999", () => {
    expect(normalize("0 7 13 20 42 100 105 999")).toBe(
      "zero seven thirteen twenty forty two one hundred one hundred five nine hundred ninety nine",
    );
    expect(normalize("1000 1,234 999999")).toBe(
      "one thousand one thousand two hundred thirty four nine hundred ninety nine thousand nine hundred ninety nine",
    );
  });

  it("spells clock times", () => {
    expect(normalize("3:15")).toBe("three fifteen");
    expect(normalize("10:05")).toBe("ten oh five");
    expect(normalize("7:00")).toBe("seven o'clock");
  });

  it("spells ordinals and decimals", () => {
    expect(normalize("1st 2nd 3rd 4th 21st 100th")).toBe(
      "first second third fourth twenty first one hundredth",
    );
    expect(normalize("3.5")).toBe("three point five");
  });

  it("digits and words normalize to the same thing", () => {
    expect(normalize("I waited 20 years")).toBe(normalize("I waited twenty years"));
  });

  it("empty input gives empty string", () => {
    expect(normalize("  ...  ")).toBe("");
  });

  it("spells out spoken symbols instead of dropping them", () => {
    expect(normalize("You & me")).toBe("you and me");
    expect(normalize("It's $20")).toBe("it's twenty dollars");
    expect(normalize("$1 or €1 or £2")).toBe("one dollar or one euro or two pounds");
    expect(normalize("$3.50")).toBe("three dollars fifty cents");
    expect(normalize("$1,000")).toBe("one thousand dollars");
    expect(normalize("50% off")).toBe("fifty percent off");
    expect(normalize("3.5%")).toBe("three point five percent");
    expect(normalize("1+1=2")).toBe("one plus one equals two");
    expect(normalize("me@home")).toBe("me at home");
    expect(normalize("20°")).toBe("twenty degrees");
    expect(normalize("it's -5 now, −3 later")).toBe("it's minus five now minus three later");
  });

  it("keeps any other symbol as its own token so it can never vanish", () => {
    expect(normalize("#1 fan")).toBe("# one fan");
    expect(normalize("a ~ b")).toBe("a ~ b");
    expect(normalize("love ♥ you")).toBe("love ♥ you");
  });
});

describe("numberToWords", () => {
  it("covers the range edges", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(999_999)).toBe("nine hundred ninety nine thousand nine hundred ninety nine");
    expect(numberToWords(1_000_000)).toBeUndefined();
  });
});

describe("compareWords", () => {
  it("acceptance 2: one insertion", () => {
    const r = compareWords("Meet me where it started.", "meet me where it all started");
    expect(r.ops).toEqual([{ type: "ins", heard: "all" }]);
    expect(r.wer).toBe(0.2);
    expect(r.pass).toBe(false);
  });

  it("acceptance 3: punctuation and case are not errors", () => {
    const r = compareWords("I kept the watch.", "I kept the watch");
    expect(r.pass).toBe(true);
    expect(r.wer).toBe(0);
    expect(r.ops).toEqual([]);
  });

  it("substitution", () => {
    const r = compareWords("I kept the watch", "I kept the clock");
    expect(r.ops).toEqual([{ type: "sub", expected: "watch", heard: "clock" }]);
    expect(r.wer).toBe(0.25);
    expect(r.pass).toBe(false);
  });

  it("deletion", () => {
    const r = compareWords("I kept the watch", "I kept watch");
    expect(r.ops).toEqual([{ type: "del", expected: "the" }]);
    expect(r.wer).toBe(0.25);
    expect(r.pass).toBe(false);
  });

  it("empty heard gives wer = 1", () => {
    const r = compareWords("I kept the watch", "");
    expect(r.wer).toBe(1);
    expect(r.ops).toHaveLength(4);
    expect(r.ops.every((o) => o.type === "del")).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("empty expected: silence passes, any speech fails", () => {
    expect(compareWords("", "").pass).toBe(true);
    const r = compareWords("", "hello");
    expect(r.pass).toBe(false);
    expect(r.wer).toBeGreaterThan(0);
  });

  it("a single-word difference never passes, even in a long line", () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const r = compareWords(long, long.replace("word57", "word58"));
    expect(r.pass).toBe(false);
    expect(r.wer).toBeGreaterThan(0);
  });

  it("contraction vs expansion is a difference (strict gate)", () => {
    expect(compareWords("don't stop", "do not stop").pass).toBe(false);
  });

  it("digits in the script match words from the ASR", () => {
    expect(compareWords("It's 3 o'clock.", "it's three o'clock").pass).toBe(true);
  });

  it("a missing spoken symbol-word never passes", () => {
    expect(compareWords("You & me", "you me").pass).toBe(false);
    expect(compareWords("It's $20", "it's twenty").pass).toBe(false);
    expect(compareWords("50% off", "fifty off").pass).toBe(false);
    expect(compareWords("-5 degrees", "five degrees").pass).toBe(false);
    expect(compareWords("#1 fan", "one fan").pass).toBe(false);
    expect(compareWords("I ♥ you", "I you").pass).toBe(false);
  });

  it("symbols match their spoken words from the ASR", () => {
    expect(compareWords("You & me", "you and me").pass).toBe(true);
    expect(compareWords("It's $20", "it's twenty dollars").pass).toBe(true);
    expect(compareWords("50% off", "fifty percent off").pass).toBe(true);
  });

  it("returns normalized expected and heard", () => {
    const r = compareWords("Hi, Bob!", "hi bob");
    expect(r.expected).toBe("hi bob");
    expect(r.heard).toBe("hi bob");
  });
});

describe("extractQuotedLines", () => {
  it("handles all four quote styles in order", () => {
    const idea = `He says "one." She says “two!” Then «three?» and „four…“ at last.`;
    expect(extractQuotedLines(idea)).toEqual(["one.", "two!", "three?", "four…"]);
  });

  it("handles multiple quotes of the same style", () => {
    expect(extractQuotedLines(`"A, b." then "C — d!"`)).toEqual(["A, b.", "C — d!"]);
  });

  it("keeps inner text exactly as written, including spaces and punctuation", () => {
    expect(extractQuotedLines(`She reads: " Meet me where it started. "`)).toEqual([" Meet me where it started. "]);
  });

  it("ignores apostrophes and single quotes", () => {
    expect(extractQuotedLines("It's late and he said 'go' to Bob's dog.")).toEqual([]);
    expect(extractQuotedLines(`It's what she said: "I can't."`)).toEqual(["I can't."]);
  });

  it("returns [] when there are no quotes, and ignores empty quotes", () => {
    expect(extractQuotedLines("A barista finds a note.")).toEqual([]);
    expect(extractQuotedLines(`An empty "" quote`)).toEqual([]);
  });
});

// --- F10: hard lines ---

describe("compareLine: the gate's view of a script line (F10 acceptance 1)", () => {
  const MUST_PASS: [string, string][] = [
    ["1987", "nineteen eighty-seven"],
    ["1987", "1987"],
    ["1987", "one thousand nine hundred eighty seven"],
    ["2005", "two thousand five"],
    ["2026", "twenty twenty six"],
    ["It's 3:15 a.m.", "It's 3.15 AM"],
    ["It's 3:15 a.m.", "it's three fifteen a.m."],
    ["3:15am", "3:15 AM"],
    ["$4.50", "four fifty"],
    ["$4.50", "four dollars and fifty cents"],
    ["$4.50", "four dollars fifty cents"],
    ["$4.50", "four dollars fifty"],
    ["$4.50", "four fifty dollars"],
    // Live 2026-10-20: Whisper wrote the digits' "four" as "for".
    ["$4.50", "for fifty dollars"],
    ["$2", "to dollars"],
    ["$4.50", "$4.50"],
    ["It's $20", "it's twenty dollars"],
    ["Zoë", "Zoe"],
    ["Nguyễn", "Nguyen"],
    ["Siobhán", "Siobhan"],
    ["the FBI", "the F.B.I."],
    ["the FBI", "the f b i"],
    ["the FBI", "the F-B-I"],
    // A following "I" / "a" is its own word, never merged into the initialism (F10 attempt-2 review).
    ["At 3 a.m. I left.", "At 3 AM I left."],
    ["At 3 a.m. I left.", "At 3 a m I left."],
    ["At 3 p.m. a man left.", "At 3 PM a man left."],
    ["It's 3:15 a.m. I know.", "It's 3.15 AM, I know."],
    ["The F.B.I. I trust.", "The FBI I trust."],
    ["The F.B.I. I trust.", "The f b i I trust."],
    ["The FBI I trust.", "The F.B.I. I trust."],
    ["I a.m. sure", "I AM sure"],
    ["Am I a fool?", "am I a fool"],
    ["Am I a fool?", "Am I a fool?"],
    ["Dr. Patel", "Doctor Patel"],
    ["Mr. Nguyễn", "Mister Nguyen"],
    ["24/7", "twenty four seven"],
    ["24/7", "24-7"],
    ["Go! 🚀", "Go!"],
    ["Okay. [laughs]", "Okay. Ha ha."],
    ["Okay. [laughs]", "Okay. (laughs)"],
    ["You actually believed me? [laughs]", "You actually believed me? Hahaha."],
    [
      "It's $4.50, it's 3:15 a.m., and we've been open 24/7 since 1987.",
      "It's four fifty, it's 3.15 AM, and we've been open 24-7 since nineteen eighty-seven.",
    ],
  ];
  const MUST_FAIL: [string, string][] = [
    ["1987", "1988"],
    ["1987", "nineteen eighty-eight"],
    ["$4.50", "four dollars"],
    ["$4.50", "four"],
    // Same-sound number words count only inside a digit span; in plain words "four" and "for" differ.
    ["four apples", "for apples"],
    ["Zoë", "Zoey"],
    ["the FBI", "the CIA"],
    ["The F.B.I. I trust.", "The FBI trust."],
    ["At 3 a.m. I left.", "At 3 AM left."],
    ["Am I a fool?", "Am I fool?"],
    ["Meet me at 3:15", "Meet me at three"],
    ["You & me", "you me"],
    ["It's $20", "it's twenty"],
    ["Dr. Patel", "Patel"],
    ["Okay.", "Okay. Ha ha."], // no laugh tag: laughter is an inserted word
    ["Okay. [laughs]", "Okay, okay."], // the tag only excuses laughter, never a word
    ["Go! 🚀", "Go rocket"],
  ];

  it.each(MUST_PASS)("passes %j heard as %j", (line, heard) => {
    const r = compareLine(line, heard);
    expect(r.ops).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.wer).toBe(0);
  });

  it.each(MUST_FAIL)("fails %j heard as %j", (line, heard) => {
    const r = compareLine(line, heard);
    expect(r.pass).toBe(false);
    expect(r.wer).toBeGreaterThan(0);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it("reports the laughter and non-speech tags it ignored", () => {
    expect(compareLine("Okay. [laughs]", "Okay. Ha ha.").ignored).toEqual(["ha", "ha"]);
    expect(compareLine("Okay.", "(sighs) Okay.").ignored).toEqual(["(sighs)"]);
    expect(compareLine("Okay.", "Okay.").ignored).toBeUndefined();
  });

  it("caps each span on its own: a span past the cap keeps its canonical reading, a later small one still expands", () => {
    // 4 two-way years → 16 readings; $4.50 (3 readings) would make 48 > 32, so it is capped; 1985 (2) → 32 fits.
    const line = "1981 1982 1983 1984 $4.50 1985";
    const years = "nineteen eighty one nineteen eighty two nineteen eighty three nineteen eighty four";
    expect(compareLine(line, `${years} four dollars fifty cents one thousand nine hundred eighty five`).pass).toBe(true);
    expect(compareLine(line, `${years} four fifty nineteen eighty five`).pass).toBe(false);
  });

  it("reports ops against the closest reading pair", () => {
    const r = compareLine("Since 1987.", "since nineteen eighty eight");
    expect(r.ops).toEqual([{ type: "sub", expected: "seven", heard: "eight" }]);
    expect(r.wer).toBeCloseTo(1 / 4);
  });

  it("keeps the reading expansion bounded", () => {
    // 12 years: 2^12 combinations uncapped. Must stay fast and still compare the canonical reading.
    const line = Array.from({ length: 12 }, (_, i) => String(1980 + i)).join(" ");
    expect(MAX_READINGS).toBeLessThanOrEqual(64);
    const t0 = performance.now();
    expect(compareLine(line, normalize(line)).pass).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("normalize (F10)", () => {
  it("folds diacritics and abbreviations", () => {
    expect(normalize("Zoë, Nguyễn, Siobhán")).toBe("zoe nguyen siobhan");
    expect(normalize("Dr. Patel, Mr. X, Mrs. Y, Ms. Z")).toBe("doctor patel mister x missus y miz z");
  });
  it("joins only dotted / hyphenated initialisms; spaced letters stay words", () => {
    expect(normalize("F.B.I.")).toBe("fbi");
    expect(normalize("F-B-I")).toBe("fbi");
    expect(normalize("3 a.m.")).toBe("three am");
    expect(normalize("3 P.M.")).toBe("three pm");
    expect(normalize("At 3 a.m. I left.")).toBe("at three am i left");
    expect(normalize("The F.B.I. I trust.")).toBe("the fbi i trust");
    expect(normalize("Am I a fool?")).toBe("am i a fool");
    expect(normalize("the f b i")).toBe("the f b i"); // canonical as written; "fbi" is an alternative reading
  });
  it("reads 1100–2099 as a year (canonical) and counts it as spoken", () => {
    expect(normalize("1987")).toBe("nineteen eighty seven");
    expect(normalize("2005")).toBe("two thousand five");
    expect(normalize("1,987")).toBe("one thousand nine hundred eighty seven");
    expect(wordCount("It stopped in 1987, at 3:15 a.m., and so did I.")).toBe(14);
  });
});

describe("splitDelivery (F10)", () => {
  it("moves emoji out of the spoken text", () => {
    expect(splitDelivery("Dr. Patel, NASA and the FBI are on line two 🚀")).toEqual({
      spoken: "Dr. Patel, NASA and the FBI are on line two",
      tags: [],
      emoji: ["🚀"],
    });
    expect(splitDelivery("Hi 👍🏽 there ❤️").spoken).toBe("Hi there");
  });
  it("treats *actions* as delivery tags", () => {
    expect(splitDelivery("*sighs* Fine.")).toEqual({ spoken: "Fine.", tags: ["sighs"] });
    expect(splitDelivery("*laughs softly* Okay. *clears throat*")).toEqual({ spoken: "Okay.", tags: ["laughs softly", "clears throat"] });
  });
  it("keeps *emphasis* on a real word as spoken text: only known non-speech actions are tags", () => {
    expect(splitDelivery("I *really* mean it.")).toEqual({ spoken: "I *really* mean it.", tags: [] });
    expect(splitDelivery("*Stop* *right* there.").tags).toEqual([]);
    expect(splitDelivery("We *grind*, those are *nodes*.").tags).toEqual([]); // stem + suffix never forms a real word
  });
  it("must-fail: an emphasised word that was not spoken still fails the gate", () => {
    expect(compareLine("I *really* mean it.", "I mean it.").pass).toBe(false);
    expect(compareLine("I *really* mean it.", "I really mean it.").pass).toBe(true);
    // A starred word in the transcript is only dropped when it is a known non-speech action.
    expect(compareLine("I mean it.", "I *really* mean it.").pass).toBe(false);
    expect(compareLine("I mean it.", "*sighs* I mean it.")).toMatchObject({ pass: true, ignored: ["*sighs*"] });
  });
});

describe("private-use characters in the text (F10)", () => {
  it("never collide with the span placeholders", () => {
    expect(() => compareLine("I love my ", "I love my")).not.toThrow();
    expect(compareLine("I love my ", "I love my").pass).toBe(true);
    expect(wordCount("Hi ")).toBe(1);
    expect(normalize("Since 1987 ")).toBe("since nineteen eighty seven");
    expect(compareWords("Since 1987 ", "since nineteen eighty seven").pass).toBe(true);
    expect(compareWords(" ", "").pass).toBe(true);
  });
  it("must-fail: a private-use character can't stand in for a span", () => {
    expect(compareWords("Since 1987", "since ").pass).toBe(false);
    expect(compareWords("Since ", "since nineteen eighty seven").pass).toBe(false);
  });
});

describe("extractQuotedLines (F10): nested quotes fail fast", () => {
  it("rejects double quotes inside a double-quoted line", () => {
    const idea = 'A drama teacher stops the rehearsal and says: "When I say "stop," you stop. Not "in a minute." Now."';
    expect(() => extractQuotedLines(idea)).toThrow(QuoteError);
    expect(() => extractQuotedLines(idea)).toThrow("nested double quotes: use single quotes inside the line");
  });
  it("rejects an odd number of straight quotes, touching quotes and nested curly quotes", () => {
    expect(() => extractQuotedLines('He says "I said "no" again.')).toThrow(/nested double quotes/);
    expect(() => extractQuotedLines('She says "Hi." "Bye."')).toThrow(/nested double quotes/);
    expect(() => extractQuotedLines("She says “He said “no” to me.”")).toThrow(/nested double quotes/);
  });
  it("still accepts single quotes inside and several separate quotes", () => {
    expect(extractQuotedLines(`He reads: "He wrote 'don't wait for me' and waited."`)).toEqual([
      "He wrote 'don't wait for me' and waited.",
    ]);
    expect(extractQuotedLines('He asks "Where were you?", then "Who saw you?"')).toEqual(["Where were you?", "Who saw you?"]);
  });
});

describe("nonLatinLetters", () => {
  it("finds Cyrillic and other non-Latin letters, ignores accents and digits", () => {
    expect(nonLatinLetters("Мамо, я вдома. I'm home.")).not.toEqual([]);
    expect(nonLatinLetters("Zoë, Nguyễn, 1987, $4.50 🚀")).toEqual([]);
  });
});

describe("same-sound spellings (live 2026-10-19: a correct take failed on Kiev and tickets)", () => {
  it("apostrophe-s and spelling variants of one spoken word pass", () => {
    const line = "Ticket's $4.50, and this train left Kyiv in 1987 — it doesn't stop for anyone.";
    expect(compareWords(line, "Tickets $4.50, and this train left Kiev in 1987, it doesn't stop for anyone.").pass).toBe(true);
    expect(compareWords("It's grey in Odesa.", "Its gray in Odessa.").pass).toBe(true);
    expect(compareWords("Okay, Kharkiv.", "OK, Kharkov.").pass).toBe(true);
  });
  it("a number written in digits may come back as its same-sound word (live 2026-10-20: a $2.9 run failed on it)", () => {
    expect(compareWords("Ticket's $4.50.", "Tickets for 50 dollars.").pass).toBe(true);
    expect(compareWords("Ticket's $4.50.", "Tickets for 60 dollars.").pass).toBe(false);
  });
  it("different words that only sound close still fail", () => {
    expect(compareWords("We'll go.", "Well go.").pass).toBe(false);
    expect(compareWords("Ticket's four fifty.", "Tickets for fifty.").pass).toBe(false);
    expect(compareWords("Kyiv, 1987.", "Kiev, 1988.").pass).toBe(false);
  });
});
