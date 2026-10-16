import { describe, expect, it } from "vitest";
import { compareWords, extractQuotedLines, normalize, numberToWords } from "../src/verbatim.ts";

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
