import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runPipeline } from "../src/graph.ts";
import {
  createProviders,
  MockImage,
  MockLlm,
  mockScriptResponder,
  MockTts,
  MockVideo,
} from "../src/providers/index.ts";
import { DEFAULT_SCRIPT_MODELS, GEMINI_PRICES, GeminiLlm, toGeminiSchema, type GenAiClient } from "../src/providers/gemini.ts";
import { DEFAULT_JUDGE_MODELS } from "../src/providers/gemini-judge.ts";
import { firstPrompt, SCRIPT_PROMPT_VERSION, SCRIPT_SYSTEM } from "../src/prompts/script.ts";
import { IdeaRejectedError, preSpendProblems, ScriptError, scriptProblems, writeScript } from "../src/nodes/script.ts";
import { isWide, Script, ScriptDraft, type Shot } from "../src/schemas.ts";
import { differentSpeakers, quoteSpeakers } from "../src/speakers.ts";
import { extractQuotedLines } from "../src/verbatim.ts";

const QUOTE = "Meet me where it all started.";
const IDEA = `A tired barista finds a note in the tip jar. She reads it aloud: "${QUOTE}"`;
const LOOK = "late twenties, tired brown eyes, dark hair in a messy bun, flour on her cheek, green apron over a grey tee";

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: "s1",
    camera: "close-up",
    visual: "She unfolds a small note above the tip jar",
    motion: "slow push-in on her face",
    emotion: "hopeful disbelief",
    line: QUOTE,
    seconds: 8,
    speaker: "Maya",
    onScreen: ["Maya"],
    ...over,
  };
}

const MAYA = {
  name: "Maya",
  look: LOOK,
  voice: { gender: "female" as const, age: "adult" as const, tone: "soft, tired" },
  voiceDescription: "soft, tired female voice, late twenties, neutral American accent, unhurried",
};

function draft(shots: Shot[] = [shot()], look = LOOK): ScriptDraft {
  return {
    title: "The Note",
    logline: "A barista finds a note from someone she lost.",
    setting: "Small café counter at closing time",
    characters: [{ ...MAYA, look }],
    shots,
  };
}

function script(d: ScriptDraft, quotedLines: string[] = [QUOTE]): Script {
  return { ...d, promptVersion: SCRIPT_PROMPT_VERSION, quotedLines };
}

describe("prompt", () => {
  it("has a version and the verbatim rule", () => {
    expect(SCRIPT_PROMPT_VERSION).toMatch(/\S/);
    expect(SCRIPT_SYSTEM).toMatch(/character-for-character/);
    expect(SCRIPT_SYSTEM).toMatch(/16 words/);
  });
});

describe("scriptProblems", () => {
  it("accepts a correct script", () => {
    expect(scriptProblems(script(draft()), IDEA)).toEqual([]);
  });

  it("rejects a paraphrased quote", () => {
    const s = script(draft([shot({ line: "Meet me where it started." })]));
    const p = scriptProblems(s, IDEA);
    expect(p.join("\n")).toContain(`"${QUOTE}"`);
    expect(p.join("\n")).toMatch(/exactly/);
  });

  it("rejects a quote that differs only in punctuation or case", () => {
    expect(scriptProblems(script(draft([shot({ line: "Meet me where it all started" })])), IDEA)).not.toEqual([]);
    expect(scriptProblems(script(draft([shot({ line: "meet me where it all started." })])), IDEA)).not.toEqual([]);
  });

  it("rejects quotedLines that differ from the idea's quotes", () => {
    const p = scriptProblems(script(draft(), []), IDEA);
    expect(p.join("\n")).toMatch(/quotedLines/);
  });

  it("flags total duration with a specific message (acceptance 2)", () => {
    const short = scriptProblems(script(draft([shot({ seconds: 5 })])), IDEA);
    expect(short).toContainEqual(expect.stringMatching(/total duration 5 s is outside 8–30 s/));
    const long = scriptProblems(
      script(draft([shot({ seconds: 20 }), shot({ id: "s2", line: "", seconds: 15 })])),
      IDEA,
    );
    expect(long).toContainEqual(expect.stringMatching(/total duration 35 s is outside 8–30 s/));
  });

  it("flags shot count with a specific message (acceptance 2)", () => {
    // F12: up to 4 shots.
    const ids = ["s2", "s3", "s4", "s4"] as const;
    const five = [shot({ seconds: 4 }), ...ids.map((id) => shot({ id, line: "", seconds: 4 }))];
    expect(scriptProblems(script(draft(five)), IDEA)).toContainEqual(expect.stringMatching(/1–4 shots, got 5/));
    expect(scriptProblems(script(draft(five.slice(0, 4))), IDEA)).toEqual([]);
    expect(scriptProblems(script(draft([])), IDEA)).toContainEqual(expect.stringMatching(/1–4 shots, got 0/));
  });

  it("flags digits in a non-quoted line, but not in a quoted one (acceptance 2)", () => {
    const idea = "A man checks his watch at the station.";
    const p = scriptProblems(script(draft([shot({ line: "The 9 train is late again." })]), []), idea);
    expect(p).toContainEqual(expect.stringMatching(/shot s1 line has digits "9".*spell numbers out/));
    const quoted = 'He says "Platform 9, 3:15." and waits.';
    const ok = scriptProblems(script(draft([shot({ line: "Platform 9, 3:15." })]), ["Platform 9, 3:15."]), quoted);
    expect(ok.filter((m) => /digit/.test(m))).toEqual([]);
  });

  it("flags an unspeakable line with a specific message (acceptance 2)", () => {
    // 16 words → 16 / 2.6 + 0.8 ≈ 6.95 s > 4 s.
    const line = "I have been waiting here every single night for you to come back through that door";
    const p = scriptProblems(script(draft([shot({ line, seconds: 4 }), shot({ id: "s2", line: "", seconds: 6 })]), []), "x");
    expect(p).toContainEqual(expect.stringMatching(/shot s1: 16 words need 7\.0 s .* has 4 s/));
  });

  it("flags a thin character.look", () => {
    const p = scriptProblems(script(draft([shot()], "a tired barista")), IDEA);
    expect(p).toContainEqual(expect.stringMatching(/characters\[0\]\.look \(Maya\) has 3 words; needs at least 12/));
  });

  it("flags wrong shot ids", () => {
    const p = scriptProblems(script(draft([shot({ id: "s2" })])), IDEA);
    expect(p).toContainEqual(expect.stringMatching(/shot 1 must have id "s1"/));
  });
});

describe("speakers (F11)", () => {
  const OPEN = "Open it after I leave.";
  const SICK = "Mom, are you sick?";
  const KITCHEN = `At the kitchen table, a mother slides an envelope to her son. She says: "${OPEN}" He looks up and asks: "${SICK}"`;
  const LEO = {
    name: "Leo",
    look: "a man in his early twenties, curly brown hair, thin silver glasses, a navy hoodie with frayed cuffs",
    voice: { gender: "male" as const, age: "young" as const, tone: "anxious" },
    voiceDescription: "soft, anxious young male voice, early twenties, light American accent, quick",
  };
  const two = (s1: Partial<Shot>, s2: Partial<Shot>, characters = [MAYA, LEO]): Script =>
    script({ ...draft([shot({ line: OPEN, seconds: 5, ...s1 }), shot({ id: "s2", line: SICK, seconds: 5, ...s2 })]), characters }, [OPEN, SICK]);

  it("accepts a dialogue: two characters, one line each, each line with its speaker", () => {
    expect(scriptProblems(two({}, { speaker: "Leo", onScreen: ["Leo"] }), KITCHEN)).toEqual([]);
  });

  it("rejects one character saying both halves when the idea names two speakers (the 'Mom' bug)", () => {
    const p = scriptProblems(two({}, {}, [MAYA]), KITCHEN);
    expect(p).toContainEqual(expect.stringMatching(/two different people \(she and he\) but the script has 1 character/));
  });

  it("rejects two characters when one of them says both attributed lines", () => {
    const p = scriptProblems(two({}, {}), KITCHEN);
    expect(p).toContainEqual(expect.stringMatching(/"Open it after I leave\." \(she\) and "Mom, are you sick\?" \(he\) are said by different people.*"Maya" says both/));
  });

  it("rejects a 'he' line given to a female voice", () => {
    const p = scriptProblems(two({ speaker: "Leo", onScreen: ["Leo"] }, { speaker: "Maya", onScreen: ["Maya"] }), KITCHEN);
    expect(p).toContainEqual(expect.stringMatching(/"Open it after I leave\." \(she\) is said by a female speaker.*"Leo" has a male voice/));
    expect(p).toContainEqual(expect.stringMatching(/"Mom, are you sick\?" \(he\) is said by a male speaker.*"Maya" has a female voice/));
  });

  it("reports a missing or unknown speaker to the model", () => {
    expect(scriptProblems(script(draft([shot({ speaker: undefined })])), IDEA)).toContainEqual(expect.stringMatching(/shot s1 has a spoken line but no speaker/));
    expect(scriptProblems(script(draft([shot({ speaker: "Leo", onScreen: ["Leo"] })])), IDEA)).toContainEqual(expect.stringMatching(/speaker "Leo" is not one of the characters/));
  });

  it("one speaker with several quotes, or no attribution, needs no second character", () => {
    const idea = 'A detective leans in. He asks "Where were you?", then "Who saw you?"';
    const s = script(
      { ...draft([shot({ line: "Where were you?", seconds: 5 }), shot({ id: "s2", line: "Who saw you?", seconds: 5 })]), characters: [{ ...MAYA, voice: { ...MAYA.voice, gender: "male" } }] },
      ["Where were you?", "Who saw you?"],
    );
    expect(scriptProblems(s, idea)).toEqual([]);
    expect(scriptProblems(script(draft()), `A note says: "${QUOTE}"`)).toEqual([]);
  });

  it("an idea that changes speaker more often than there are shots is rejected before any spend", () => {
    // F12: 4 shots, so up to 4 turns; a fifth turn is rejected.
    const four = 'She says: "One." He says: "Two." She says: "Three." He says: "Four."';
    expect(preSpendProblems(four)).toEqual([]);
    const idea = `${four} She says: "Five."`;
    expect(preSpendProblems(idea)).toContainEqual(expect.stringMatching(/change speaker 4 times, but each of the 4 shots has one speaker/));
    expect(preSpendProblems(KITCHEN)).toEqual([]);
  });

  it("quoteSpeakers reads attributions; a pronoun and a noun of one gender may be the same person", () => {
    expect(quoteSpeakers(KITCHEN).map((a) => a?.who)).toEqual(["she", "he"]);
    const same = quoteSpeakers('The mother says: "Go." She adds: "Now."');
    expect(differentSpeakers(same[0], same[1])).toBe(false);
    const nouns = quoteSpeakers('The detective says: "Sit." The suspect answers: "No."');
    expect(differentSpeakers(nouns[0], nouns[1])).toBe(true);
    // Only the subject's own words decide the gender, not who they act on.
    expect(quoteSpeakers('A teenager hugs her dad and says: "Hi."')[0]).toMatchObject({ who: "teenager" });
    expect(quoteSpeakers('An old fisherman talks to the sea: "Hi."')).toEqual([undefined]);
  });

  it("a speech tag after the quote belongs to that quote, not the next one", () => {
    expect(quoteSpeakers(`"Open it after I leave," she says. "${SICK}" he asks.`).map((a) => a?.who)).toEqual(["she", "he"]);
    expect(quoteSpeakers('"Sit down!" the detective snaps. "Why?" the suspect asks.').map((a) => a?.who)).toEqual(["detective", "suspect"]);
    // Inverted tag, and a tag after "?" / "!" (lowercase continues the sentence).
    expect(quoteSpeakers('"Go," says the mother. "Now?" asks her son.').map((a) => a?.gender)).toEqual(["female", "male"]);
    // A capitalised sentence after a full stop is the next quote's lead-in, not a tag.
    expect(quoteSpeakers(`She says: "${OPEN}" He looks up and asks: "${SICK}"`).map((a) => a?.who)).toEqual(["she", "he"]);
    // No tag at all: the second quote still inherits.
    expect(quoteSpeakers('"Hi," she says. "How are you?"').map((a) => a?.who)).toEqual(["she", "she"]);
  });

  it("a script for a tag-after-quote dialogue: the right cast passes, one character saying both is rejected", () => {
    const idea = `At the kitchen table, a mother slides an envelope to her son. "Open it after I leave," she says. "${SICK}" he asks.`;
    const line1 = "Open it after I leave,";
    const mk = (s2: Partial<Shot>, characters = [MAYA, LEO]): Script =>
      script({ ...draft([shot({ line: line1, seconds: 5 }), shot({ id: "s2", line: SICK, seconds: 5, ...s2 })]), characters }, [line1, SICK]);
    const ok = scriptProblems(mk({ speaker: "Leo", onScreen: ["Leo"] }), idea);
    expect(ok.filter((p) => /speaker|character/.test(p))).toEqual([]);
    expect(scriptProblems(mk({}, [MAYA]), idea)).toContainEqual(expect.stringMatching(/two different people \(she and he\)/));
  });

  it("a pronoun after a connective is still the pronoun ('Then she adds')", () => {
    const a = quoteSpeakers('The mother says: "Go." Then she adds: "Now."');
    expect(a[1]).toMatchObject({ who: "she", pronoun: true, gender: "female" });
    expect(differentSpeakers(a[0], a[1])).toBe(false);
    expect(quoteSpeakers('He sits. Finally, he whispers: "Stay."')[0]).toMatchObject({ who: "he", pronoun: true });
    // Connectives are not speakers either.
    const nouns = quoteSpeakers('The detective says: "Sit." Then the suspect answers: "No."');
    expect(nouns.map((x) => x?.who)).toEqual(["detective", "suspect"]);
  });

  it("a possessive does not set the speaker ('The bride's father says')", () => {
    expect(quoteSpeakers('The bride\'s father says: "Welcome."')[0]).toMatchObject({ who: "father", gender: "male" });
    expect(quoteSpeakers("The groom’s mother says: \"Welcome.\"")[0]).toMatchObject({ who: "mother", gender: "female" });
    expect(quoteSpeakers('My sister\'s husband asks: "Ready?"')[0]).toMatchObject({ who: "husband", gender: "male" });
  });

  it("a pronoun in a leading subordinate clause is not the speaker ('As she opens the door, her husband asks')", () => {
    const WHERE = "Where were you?";
    const door = `As she opens the door, her husband asks: "${WHERE}"`;
    expect(quoteSpeakers(door)[0]).toMatchObject({ who: "husband", gender: "male", pronoun: false });
    // The right script (husband with a male voice) passes; a female voice is the one that gets flagged.
    const one = (gender: "female" | "male"): Script =>
      script({ ...draft([shot({ line: WHERE, seconds: 8 })]), characters: [{ ...MAYA, voice: { ...MAYA.voice, gender } }] }, [WHERE]);
    expect(scriptProblems(one("male"), door)).toEqual([]);
    expect(scriptProblems(one("female"), door)).toContainEqual(expect.stringMatching(/is said by a male speaker.*"Maya" has a female voice/));

    const late = 'When he walks in, his wife says: "You are late." He answers: "I know."';
    const said = quoteSpeakers(late);
    expect(said.map((a) => a?.who)).toEqual(["wife", "he"]);
    expect(differentSpeakers(said[0], said[1])).toBe(true);
    const solo = script(
      { ...draft([shot({ line: "You are late.", seconds: 5 }), shot({ id: "s2", line: "I know.", seconds: 5 })]), characters: [MAYA] },
      ["You are late.", "I know."],
    );
    expect(scriptProblems(solo, late)).toContainEqual(expect.stringMatching(/two different people \(wife and he\) but the script has 1 character/));
    // Connective first, and the other subordinators too.
    expect(quoteSpeakers('Then, while he cooks, the mother says: "Eat."')[0]).toMatchObject({ who: "mother", gender: "female" });
    expect(quoteSpeakers('After she leaves, he whispers: "Finally."')[0]).toMatchObject({ who: "he", gender: "male" });
  });

  it("writeScript on the dialogue idea with the mock writer: two characters, s1.speaker ≠ s2.speaker", async () => {
    const llm = new MockLlm({ responder: mockScriptResponder });
    const { script: s } = await writeScript(KITCHEN, { llm });
    expect(s.characters).toHaveLength(2);
    expect(s.shots.map((x) => x.line)).toEqual([OPEN, SICK]);
    expect(s.shots[0]!.speaker).not.toBe(s.shots[1]!.speaker);
    const genderOf = (name?: string) => s.characters.find((c) => c.name === name)?.voice.gender;
    expect(s.shots.map((x) => genderOf(x.speaker))).toEqual(["female", "male"]);
    expect(llm.calls).toHaveLength(1);
  });

  it("the prompt asks for 1–2 characters, one speaker per spoken shot, shot-reverse-shot and voiceDescription", () => {
    expect(SCRIPT_PROMPT_VERSION).toBe("script-v5");
    expect(SCRIPT_SYSTEM).toMatch(/"characters" has 1 or 2 entries/);
    expect(SCRIPT_SYSTEM).toMatch(/exactly one "speaker"/);
    expect(SCRIPT_SYSTEM).toMatch(/shot-reverse-shot/);
    expect(SCRIPT_SYSTEM).toMatch(/voiceDescription/);
  });
});

describe("writeScript", () => {
  it("re-prompts with the problem after a paraphrase, then passes (acceptance 1)", async () => {
    const bad = draft([shot({ line: "Meet me where it started." })]);
    const llm = new MockLlm({ queue: [bad, draft()] });
    const { script: s, attempts } = await writeScript(IDEA, { llm });
    expect(s.shots[0]!.line).toBe(QUOTE);
    expect(s.quotedLines).toEqual([QUOTE]);
    expect(s.promptVersion).toBe(SCRIPT_PROMPT_VERSION);
    expect(Script.safeParse(s).success).toBe(true);
    expect(llm.calls).toHaveLength(2);
    const problem = scriptProblems(script(bad), IDEA)[0]!;
    expect(llm.calls[1]!.prompt).toContain(problem);
    expect(llm.calls[1]!.prompt).toContain('"Meet me where it started."'); // the previous JSON
    expect(llm.calls[0]!.system).toBe(SCRIPT_SYSTEM);
    expect(attempts.map((a) => [a.stage, a.n, a.ok, a.provider])).toEqual([
      ["script", 1, false, "mock-llm"],
      ["script", 2, true, "mock-llm"],
    ]);
    expect(attempts[0]!.reason).toContain(problem);
    for (const a of attempts) expect(a.costUsd).toBe(0);
  });

  it("tells the model the quoted lines in the first prompt", async () => {
    const llm = new MockLlm({ queue: [draft()] });
    await writeScript(IDEA, { llm });
    expect(llm.calls[0]!.prompt).toContain(IDEA);
    expect(llm.calls[0]!.prompt).toContain(JSON.stringify(QUOTE));
  });

  it("throws ScriptError with the problems after 3 bad answers (acceptance 3)", async () => {
    const bad = draft([shot({ line: "Meet me where it started.", seconds: 5 })]);
    const llm = new MockLlm({ queue: [bad, bad, bad, draft()] });
    const err = await writeScript(IDEA, { llm }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    const e = err as ScriptError;
    expect(e.problems).toEqual(scriptProblems(script(bad), IDEA));
    expect(e.problems.join("\n")).toMatch(/total duration 5 s/);
    expect(e.message).toContain(e.problems[0]);
    expect(e.attempts).toHaveLength(3);
    expect(e.attempts.every((a) => !a.ok)).toBe(true);
    expect(llm.calls).toHaveLength(3);
  });

  it("feeds a bad shape back as problems", async () => {
    const llm = new MockLlm({ queue: [{ title: "x" }, draft()] });
    const { attempts } = await writeScript(IDEA, { llm });
    expect(attempts[0]!.ok).toBe(false);
    expect(llm.calls[1]!.prompt).toMatch(/character/);
  });

  it("without quotes, a valid generated line passes and quotedLines is [] (acceptance 4)", async () => {
    const idea = "An old fisherman finds his late wife's ring in a fish at dawn.";
    const d = draft([shot({ line: "You always said you'd come back to me.", seconds: 6 }), shot({ id: "s2", line: "", seconds: 4 })]);
    const llm = new MockLlm({ queue: [d] });
    const { script: s, attempts } = await writeScript(idea, { llm });
    expect(s.quotedLines).toEqual([]);
    expect(s.shots[0]!.line).toBe("You always said you'd come back to me.");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ok).toBe(true);
  });
});

// --- F10: pre-spend guards and several quotes per shot ---

const CYRILLIC_IDEA = 'Бабуся стоїть біля вікна. Вона тихо каже: "Я чекала на тебе цілу зиму."';
const NESTED_IDEA = 'A drama teacher stops the rehearsal and says: "When I say "stop," you stop. Not "in a minute." Now."';
const LONG_QUOTE = Array.from({ length: 40 }, (_, i) => (i % 2 ? "again" : "forever")).join(" ") + ".";
const LONG_IDEA = `An old violinist speaks to the empty hall: "${LONG_QUOTE}"`;
const THREE = ["Where were you?", "Who saw you?", "Why are you lying to me?"];
const THREE_IDEA = `A detective leans across the table. He asks "${THREE[0]}", then "${THREE[1]}", and finally "${THREE[2]}"`;

describe("preSpendProblems (F10)", () => {
  it("passes ordinary ideas", () => {
    expect(preSpendProblems(IDEA)).toEqual([]);
    expect(preSpendProblems(THREE_IDEA)).toEqual([]);
    expect(preSpendProblems("Loneliness in a big city.")).toEqual([]);
  });
  it("rejects non-Latin spoken lines with the README's reason", () => {
    expect(preSpendProblems(CYRILLIC_IDEA)).toEqual([
      "only English lines are supported in this PoC (no video model officially supports Ukrainian speech yet); write the line in English",
    ]);
    expect(preSpendProblems('He calls: "Мамо, я вдома. I\'m home."')).toHaveLength(1);
  });
  it("rejects nested double quotes", () => {
    expect(preSpendProblems(NESTED_IDEA)).toEqual(["nested double quotes: use single quotes inside the line"]);
  });
  it("rejects a single quote longer than one shot can hold", () => {
    const p = preSpendProblems(LONG_IDEA);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/40 words need 16\.2 s .* at most 15 s/);
  });
  it("rejects quotes that cannot fit 4 shots × 15 s, accepts ones that can (F12: 4 shots)", () => {
    const twenty = (w: string) => Array.from({ length: 20 }, () => w).join(" ");
    const words = ["one", "two", "three", "four", "five"];
    const tooMany = `He says ${words.map((w) => `"${twenty(w)}"`).join(" then ")}`;
    expect(preSpendProblems(tooMany)[0]).toMatch(/5 quoted lines .* 4 shots/);
    const fits = `He says ${words.slice(0, 4).map((w) => `"${twenty(w)}"`).join(" then ")}`;
    expect(preSpendProblems(fits)).toEqual([]);
  });
});

describe("writeScript pre-spend guards (F10 acceptance 2)", () => {
  it.each([
    ["Cyrillic", CYRILLIC_IDEA, /only English lines are supported/],
    ["nested quotes", NESTED_IDEA, /nested double quotes: use single quotes inside the line/],
    ["40-word quote", LONG_IDEA, /needs? .*at most 15 s/],
  ])("%s: rejected before the first LLM call", async (_name, idea, msg) => {
    const llm = new MockLlm({ responder: mockScriptResponder });
    const err = await writeScript(idea, { llm }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdeaRejectedError);
    expect((err as Error).message).toMatch(msg);
    expect((err as IdeaRejectedError).attempts).toEqual([
      expect.objectContaining({ stage: "script", ok: false, costUsd: 0, provider: "pre-spend-check" }),
    ]);
    expect(llm.calls).toHaveLength(0);
  });

  it.each([
    ["Cyrillic", CYRILLIC_IDEA, /only English lines are supported/],
    ["nested quotes", NESTED_IDEA, /nested double quotes/],
    ["40-word quote", LONG_IDEA, /at most 15 s/],
  ])("%s: the whole pipeline makes zero LLM / image / video calls", async (_name, idea, msg) => {
    const dir = await mkdtemp(join(tmpdir(), "itv-prespend-"));
    try {
      const llm = new MockLlm({ responder: mockScriptResponder });
      const image = new MockImage();
      const video = new MockVideo();
      const tts = new MockTts();
      const providers = () => createProviders({ mode: "mock", env: {}, overrides: { llm, image, video, tts } });
      const { manifest } = await runPipeline({ idea, mode: "mock" }, { providers, runsDir: dir, maxCostUsd: 1, retry: { initialInterval: 1, jitter: false } });
      expect(manifest.ok).toBe(false);
      expect(manifest.error).toMatch(msg);
      expect(manifest.costUsd).toBe(0);
      expect([llm.calls.length, image.calls.length, video.calls.length, tts.calls.length]).toEqual([0, 0, 0, 0]);
      // A clean rejection: one attempt that says why, no transient retries.
      expect(manifest.attempts.map((a) => [a.stage, a.provider, a.ok])).toEqual([["script", "pre-spend-check", false]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an LLM-written line in another script is sent back, not accepted", () => {
    const p = scriptProblems(script(draft([shot({ line: "Я тут.", seconds: 8 })]), []), "A woman waits at a window.");
    expect(p).toContainEqual(expect.stringMatching(/only English lines are supported/));
  });
});

describe("several quoted lines per shot (F10 acceptance 3)", () => {
  // The detective idea says "He asks": since F11 the speaker's voice must be plausibly his.
  const he = (d: ScriptDraft): ScriptDraft => ({ ...d, characters: [{ ...MAYA, voice: { ...MAYA.voice, gender: "male" } }] });
  const two = (l1: string, l2: string) =>
    script(he(draft([shot({ line: l1, seconds: 5 }), shot({ id: "s2", line: l2, seconds: 5 })])), THREE);

  it("accepts two quotes in one shot, in idea order", () => {
    expect(scriptProblems(two(`${THREE[0]} ${THREE[1]}`, THREE[2]!), THREE_IDEA)).toEqual([]);
    expect(scriptProblems(two(THREE[0]!, `${THREE[1]} [softly] ${THREE[2]}`), THREE_IDEA)).toEqual([]);
  });
  it("rejects quotes out of order, split across shots, or with words added around them", () => {
    expect(scriptProblems(two(`${THREE[1]} ${THREE[0]}`, THREE[2]!), THREE_IDEA).join("\n")).toMatch(/"Who saw you\?" must appear .*exactly.*after the quoted lines before it/);
    expect(scriptProblems(two(`${THREE[0]} Who saw`, `you? ${THREE[2]}`), THREE_IDEA)).not.toEqual([]);
    expect(scriptProblems(two(`${THREE[0]} Tell me. ${THREE[1]}`, THREE[2]!), THREE_IDEA).join("\n")).toMatch(/s1.*words outside the quoted lines.*Tell me/);
  });
  it("writeScript passes when the mock LLM returns two quotes in one shot", async () => {
    const d = he(draft([shot({ line: `${THREE[0]} ${THREE[1]}`, seconds: 5 }), shot({ id: "s2", line: THREE[2]!, seconds: 5 })]));
    const llm = new MockLlm({ queue: [d] });
    const { script: s, attempts } = await writeScript(THREE_IDEA, { llm });
    expect(s.quotedLines).toEqual(THREE);
    expect(attempts.map((a) => a.ok)).toEqual([true]);
  });
  it("the built-in mock writer packs three short quotes into two shots that pass", () => {
    const quoted = extractQuotedLines(THREE_IDEA);
    const d = mockScriptResponder(firstPrompt(THREE_IDEA, quoted), { system: "", call: 0 }) as ScriptDraft;
    expect(d.shots).toHaveLength(2);
    const s = Script.parse({ ...d, promptVersion: "t", quotedLines: quoted });
    expect(scriptProblems(s, THREE_IDEA)).toEqual([]);
  });
  it("the mock writer sizes shots by spoken words, so a line with 1987 and 3:15 a.m. passes", () => {
    const idea = 'An old man fixes a clock. He says: "It stopped in 1987, at 3:15 a.m., and so did I."';
    const quoted = extractQuotedLines(idea);
    const d = mockScriptResponder(firstPrompt(idea, quoted), { system: "", call: 0 }) as ScriptDraft;
    expect(scriptProblems(Script.parse({ ...d, promptVersion: "t", quotedLines: quoted }), idea)).toEqual([]);
  });
});

describe("lip-sync limit note (F10)", () => {
  it("records 'no lip-sync fallback for this line' on the script attempt when a line is too long for it", async () => {
    const line = "I played this song at our wedding, at your funeral, and every Sunday since, and I will keep playing it.";
    const idea = `A violinist says: "${line}"`;
    const d = draft([shot({ line, seconds: 10 }), shot({ id: "s2", line: "", seconds: 4 })]);
    const { attempts } = await writeScript(idea, { llm: new MockLlm({ queue: [d] }), lipsyncMaxSeconds: 5 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ok).toBe(true);
    expect(attempts[0]!.reason).toMatch(/shot s1: .*lip-sync max 5 s: no lip-sync fallback for this line/);
    const plain = await writeScript(idea, { llm: new MockLlm({ queue: [d] }), lipsyncMaxSeconds: 10 });
    expect(plain.attempts[0]!.reason).toBeUndefined();
  });
});

describe("Gemini prices (F10)", () => {
  it.each([
    ["DEFAULT_SCRIPT_MODELS", DEFAULT_SCRIPT_MODELS],
    ["DEFAULT_JUDGE_MODELS", DEFAULT_JUDGE_MODELS],
  ])("every model in %s has a price, so no run records a paid call as $0", (_name, chain) => {
    const models = chain.split(",").map((m) => m.trim()).filter(Boolean);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(GEMINI_PRICES[m], m).toBeDefined();
      expect(GEMINI_PRICES[m]!.input).toBeGreaterThan(0);
      expect(GEMINI_PRICES[m]!.output).toBeGreaterThan(0);
    }
  });
});

// --- Gemini adapter, through a fake client only (acceptance 5) ---

type Params = Parameters<GenAiClient["models"]["generateContent"]>[0];

function fakeClient(script: (params: Params, call: number) => unknown): GenAiClient & { calls: Params[] } {
  const calls: Params[] = [];
  return {
    calls,
    models: {
      async generateContent(params: Params) {
        calls.push(params);
        const r = script(params, calls.length - 1);
        if (r instanceof Error) throw r;
        return r as Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>;
      },
    },
  };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const Small = z.object({ answer: z.string().min(1) });

describe("GeminiLlm (fake client)", () => {
  it("sends the JSON schema and system prompt, parses the answer, prices tokens", async () => {
    const client = fakeClient(() => ({
      text: JSON.stringify({ answer: "hi" }),
      usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 100_000 },
    }));
    const llm = new GeminiLlm({ client, models: ["gemini-2.5-flash"] });
    const r = await llm.generateJson({ system: "SYS", prompt: "P", schema: Small, temperature: 0.7 });
    expect(r.ok && r.data).toEqual({ answer: "hi" });
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.costUsd).toBeCloseTo(0.3 + 0.2 * 2.5, 6);
    const p = client.calls[0]!;
    expect(p.model).toBe("gemini-2.5-flash");
    expect(p.contents).toBe("P");
    expect(p.config?.systemInstruction).toBe("SYS");
    expect(p.config?.temperature).toBe(0.7);
    expect(p.config?.responseMimeType).toBe("application/json");
    expect(p.config?.responseJsonSchema).toEqual(toGeminiSchema(Small));
  });

  it("returns ok:false with the zod issues on a bad shape", async () => {
    const client = fakeClient(() => ({ text: JSON.stringify({ answer: "" }) }));
    const r = await new GeminiLlm({ client, models: ["gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/answer/);
  });

  it("returns ok:false on non-JSON text", async () => {
    const client = fakeClient(() => ({ text: "not json" }));
    const r = await new GeminiLlm({ client, models: ["gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("falls to the next model on 429/503 and records it", async () => {
    const client = fakeClient((p) =>
      p.model === "a" ? httpError(429) : p.model === "b" ? httpError(503) : { text: JSON.stringify({ answer: "ok" }) },
    );
    const r = await new GeminiLlm({ client, models: ["a", "b", "gemini-2.5-flash"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.ok).toBe(true);
    expect(client.calls.map((c) => c.model)).toEqual(["a", "b", "gemini-2.5-flash"]);
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.notes).toEqual([expect.stringMatching(/a.*429/), expect.stringMatching(/b.*503/)]);
  });

  it("throws on other errors and when every model is unavailable", async () => {
    const boom = fakeClient(() => httpError(400));
    await expect(new GeminiLlm({ client: boom, models: ["a", "b"] }).generateJson({ system: "", prompt: "", schema: Small })).rejects.toThrow(/400/);
    expect(boom.calls).toHaveLength(1);
    const busy = fakeClient(() => httpError(429));
    await expect(new GeminiLlm({ client: busy, models: ["a", "b"] }).generateJson({ system: "", prompt: "", schema: Small })).rejects.toThrow(/all models unavailable.*a.*b/);
  });

  it("notes an unknown model price instead of silently reporting it as free", async () => {
    const client = fakeClient(() => ({ text: JSON.stringify({ answer: "ok" }), usageMetadata: { promptTokenCount: 10 } }));
    const r = await new GeminiLlm({ client, models: ["mystery"] }).generateJson({ system: "", prompt: "", schema: Small });
    expect(r.costUsd).toBe(0);
    expect(r.notes).toContainEqual(expect.stringMatching(/no price.*mystery/));
  });

  it("reads the model chain and key from env", () => {
    expect(() => GeminiLlm.fromEnv({})).toThrow(/GEMINI_API_KEY/);
    const llm = GeminiLlm.fromEnv({ GEMINI_API_KEY: "k", SCRIPT_MODELS: " x , y ,," }, fakeClient(() => ({})));
    expect(llm.models).toEqual(["x", "y"]);
  });

  it("is the live llm in createProviders (client built locally, no request made)", () => {
    const env = { GEMINI_API_KEY: "k", GROQ_API_KEY: "k", FAL_KEY: "k" };
    const { llm: _unused, ...m } = createProviders({ mode: "mock", env: {} });
    const p = createProviders({ mode: "live", env, overrides: m });
    expect(p.llm).toBeInstanceOf(GeminiLlm);
    expect(p.tts).toBe(m.tts);
  });

  it("produces a schema with only keywords Gemini documents", () => {
    const s = toGeminiSchema(ScriptDraft) as Record<string, unknown>;
    expect(s.$schema).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/"(minLength|pattern|\$schema)"/);
    expect(s.type).toBe("object");
    expect(s.required).toContain("shots");
  });

  it("the live JSON schema offers all six shot sizes (F12)", () => {
    expect(JSON.stringify(toGeminiSchema(ScriptDraft))).toContain(
      '"enum":["extreme wide shot","wide shot","full shot","medium shot","medium close-up","close-up"]',
    );
  });
});

describe("storyboards (F12)", () => {
  const HELLO = "Hello? Is anyone still here?";
  const CASTLE =
    `1 кадр: маленька дівчина в червоному плащі відчиняє величезні двері старого замку. 2 кадр: вона заходить у величезну бальну залу, зала видна вся, дівчина маленька на її фоні, і каже: "${HELLO}"`;
  const FOUR =
    'Shot 1: a knight rides through a stormy valley toward a black castle. Shot 2: he dismounts at the gate. Shot 3: he looks up at the tower window. Shot 4: he calls out: "I came back for you."';

  it("the prompt replaces close framing with shot-size rules and asks for distance cues", () => {
    expect(SCRIPT_SYSTEM).not.toMatch(/keeps the face large/);
    expect(SCRIPT_SYSTEM).toMatch(/"extreme wide shot", "wide shot", "full shot", "medium shot", "medium close-up", "close-up"/);
    expect(SCRIPT_SYSTEM).toMatch(/Never two close-ups in a row, unless it is a dialogue/);
    expect(SCRIPT_SYSTEM).toMatch(/character small in the lower third/);
    expect(SCRIPT_SYSTEM).toMatch(/line is heard, not lip-read/);
    expect(SCRIPT_SYSTEM).toMatch(/2–3\s+high-contrast features that read at a distance/);
  });

  it("the user prompt lists the beats, in order; an ordinary idea gets no beats block", () => {
    const p = firstPrompt(CASTLE, [HELLO]);
    expect(p).toMatch(/storyboard of 2 beats\. Write exactly 2 shots/);
    expect(p).toContain("Beat 1 (shot s1): маленька дівчина в червоному плащі");
    expect(p.indexOf("Beat 1 (shot s1)")).toBeLessThan(p.indexOf("Beat 2 (shot s2)"));
    expect(firstPrompt(IDEA, [QUOTE])).not.toMatch(/Beat 1/);
  });

  const wide = (over: Partial<Shot> = {}) => shot({ camera: "wide shot", line: "", speaker: undefined, seconds: 4, ...over });

  it("rejects a script whose shot count is not the number of beats", () => {
    const one = script(draft([shot({ line: HELLO, seconds: 8 })]), [HELLO]);
    expect(scriptProblems(one, CASTLE)).toContainEqual(expect.stringMatching(/storyboard of 2 beats, so the script must have exactly 2 shots.*got 1/));
    const ok = script(draft([wide(), wide({ id: "s2", line: HELLO, speaker: "Maya", seconds: 5 })]), [HELLO]);
    expect(scriptProblems(ok, CASTLE)).toEqual([]);
  });

  it("rejects a quote placed in another beat's shot", () => {
    const moved = script(draft([wide({ line: HELLO, speaker: "Maya", seconds: 5 }), wide({ id: "s2" })]), [HELLO]);
    expect(scriptProblems(moved, CASTLE)).toContainEqual(
      expect.stringMatching(/"Hello\? Is anyone still here\?" is in beat 2, so it must be in shot s2's line, not in s1's/),
    );
  });

  it("pre-spend: two speakers in one beat, or beats that can't fit 30 s, are rejected for $0", () => {
    expect(preSpendProblems(CASTLE)).toEqual([]);
    expect(preSpendProblems(FOUR)).toEqual([]);
    const twoInOne = 'Shot 1: she says: "Go." He answers: "No." Shot 2: the door shuts.';
    expect(preSpendProblems(twoInOne)).toContainEqual(expect.stringMatching(/beat 1 gives lines to two different people/));
    const long = Array.from({ length: 30 }, () => "word").join(" ");
    const tooLong = `Shot 1: she says "${long}" Shot 2: he says "${long}" Shot 3: she says "${long}"`;
    expect(preSpendProblems(tooLong)).toContainEqual(expect.stringMatching(/3 beats need at least \d+ s together, over the 30 s maximum/));
  });

  it("the mock writer honours the castle storyboard: 2 shots, the line and a wide size on shot 2", async () => {
    const llm = new MockLlm({ responder: mockScriptResponder });
    const { script: s } = await writeScript(CASTLE, { llm });
    expect(s.shots.map((x) => x.id)).toEqual(["s1", "s2"]);
    expect(s.shots[1]!.line).toBe(HELLO);
    expect(isWide(s.shots[1]!.camera)).toBe(true);
    expect(s.shots[0]!.line).toBe("");
    expect(llm.calls[0]!.prompt).toMatch(/Beat 2 \(shot s2\)/);
  });

  it("the mock writer makes one shot per beat for a 4-beat storyboard, 8–30 s in total", async () => {
    const { script: s } = await writeScript(FOUR, { llm: new MockLlm({ responder: mockScriptResponder }) });
    expect(s.shots.map((x) => x.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(s.shots[3]!.line).toBe("I came back for you.");
    expect(s.shots[0]!.camera).toBe("wide shot"); // "valley", "castle"
    const total = s.shots.reduce((a, x) => a + x.seconds, 0);
    expect(total).toBeGreaterThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(30);
  });

  it("without a storyboard the mock still writes 2 shots, wide establishing shot when the idea names a place", async () => {
    const cliff = 'A tiny figure on a cliff above a stormy sea shouts: "I am not afraid of you!"';
    const { script: s } = await writeScript(cliff, { llm: new MockLlm({ responder: mockScriptResponder }) });
    expect(s.shots.map((x) => x.camera)).toEqual(["wide shot", "medium close-up"]);
  });
});
