import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Attempt,
  Character,
  RunManifest,
  Script,
  Shot,
  Transcript,
  VerbatimResult,
  CAMERAS,
  castOf,
  formatIssues,
  isWide,
  speakerOf,
} from "../src/schemas.ts";

const character = {
  name: "Mara",
  look: "woman in her late 20s, short black bob, freckles, green apron over a grey t-shirt",
  voice: { gender: "female", age: "young", tone: "tired, warm" },
  voiceDescription: "warm, slightly tired female voice, late twenties, neutral American accent, unhurried",
} as const;

const son = {
  name: "Leo",
  look: "man in his early 20s, curly brown hair, thin silver glasses, navy hoodie with frayed cuffs",
  voice: { gender: "male", age: "young", tone: "anxious, soft" },
  voiceDescription: "soft, anxious young male voice, early twenties, light American accent, quick",
} as const;

const shot = (over: Partial<z.input<typeof Shot>> = {}): z.input<typeof Shot> => ({
  id: "s1",
  camera: "close-up",
  visual: "she unfolds a note at the counter",
  motion: "slow push-in",
  emotion: "surprised, then moved",
  line: "Meet me where it started.",
  seconds: 5,
  speaker: "Mara",
  onScreen: ["Mara"],
  ...over,
});

type ScriptInput = Record<string, unknown>;
const script = (over: ScriptInput = {}): ScriptInput => ({
  promptVersion: "script-v1",
  title: "The Note",
  logline: "A barista finds a note in the tip jar.",
  setting: "small café at closing time",
  characters: [character],
  shots: [shot(), shot({ id: "s2", camera: "medium", line: "", seconds: 4, speaker: undefined })],
  quotedLines: ["Meet me where it started."],
  ...over,
});

/** A pre-F11 script: one `character`, no speaker, no onScreen, no voiceDescription. */
const legacy = (): ScriptInput => {
  const { voiceDescription: _, ...old } = character;
  const strip = ({ speaker: _s, onScreen: _o, ...rest }: z.input<typeof Shot>) => rest;
  return {
    promptVersion: "script-v3",
    title: "The Note",
    logline: "A barista finds a note in the tip jar.",
    setting: "small café at closing time",
    character: old,
    shots: [strip(shot()), strip(shot({ id: "s2", line: "", seconds: 4 }))],
    quotedLines: ["Meet me where it started."],
  };
};

/** Parse and return the readable error text, or "" when valid. */
const errorsOf = (schema: z.ZodType, value: unknown): string => {
  const r = schema.safeParse(value);
  return r.success ? "" : formatIssues(r.error);
};

describe("Script", () => {
  it("accepts a valid two-shot script", () => {
    const parsed = Script.parse(script());
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.characters[0]!.voice.gender).toBe("female");
  });

  it("accepts a valid one-shot script", () => {
    expect(Script.safeParse(script({ shots: [shot({ seconds: 8 })] })).success).toBe(true);
  });

  it("rejects a 7 s script with a readable message", () => {
    const msg = errorsOf(Script, script({ shots: [shot({ seconds: 7 })] }));
    expect(msg).toMatch(/total duration 7 s is outside 8–30 s/);
  });

  it("accepts the 8 s lower boundary, 2×15 s at the 30 s upper boundary", () => {
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 4 }), shot({ id: "s2", seconds: 4 })] }))).toBe("");
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 15 }), shot({ id: "s2", seconds: 15 })] }))).toBe("");
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 15 })] }))).toBe("");
  });

  it("keeps the total at 8–30 s even though each shot may be up to 15 s", () => {
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 15 }), shot({ id: "s2", seconds: 15.5 })] }))).toMatch(
      /shots\.1\.seconds/,
    );
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 15 }), shot({ id: "s2", seconds: 14.5 })] }))).toBe("");
  });

  it("a shot longer than 15 s is rejected at the shot path", () => {
    expect(errorsOf(Script, script({ shots: [shot({ seconds: 25 })] }))).toMatch(/shots\.0\.seconds/);
  });

  it("rejects 5 shots with a readable message (F12: up to 4)", () => {
    // "s5" is not an id at all; five valid ids (one repeated) reach the count rule.
    expect(errorsOf(Shot, shot({ id: "s5" as never }))).toMatch(/id/);
    const ids = ["s1", "s2", "s3", "s4", "s4"] as const;
    const msg = errorsOf(Script, script({ shots: ids.map((id) => shot({ id, seconds: 4 })) }));
    expect(msg).toMatch(/shots: a script has 1–4 shots, got 5/);
  });

  it("rejects 0 shots", () => {
    expect(errorsOf(Script, script({ shots: [] }))).toMatch(/a script has 1–4 shots, got 0/);
  });

  it("rejects all-empty lines with a readable message", () => {
    const msg = errorsOf(
      Script,
      script({ shots: [shot({ line: "" }), shot({ id: "s2", line: "   " })] }),
    );
    expect(msg).toMatch(/at least one shot must have a non-empty spoken line/);
  });

  it("rejects shot ids out of order or duplicated", () => {
    expect(errorsOf(Script, script({ shots: [shot({ id: "s2", seconds: 9 })] }))).toMatch(
      /shot 1 must have id "s1", got "s2"/,
    );
  });

  it("rejects bad enums and shot seconds out of 4–15 (Seedance 2.0 range)", () => {
    expect(errorsOf(Shot, shot({ camera: "wide" as never }))).toMatch(/camera/);
    expect(errorsOf(Shot, shot({ seconds: 4 }))).toBe("");
    expect(errorsOf(Shot, shot({ seconds: 15 }))).toBe("");
    expect(errorsOf(Shot, shot({ seconds: 3 }))).toMatch(/shot seconds must be 4–15/);
    expect(errorsOf(Shot, shot({ seconds: 16 }))).toMatch(/shot seconds must be 4–15/);
    expect(errorsOf(Character, { ...character, voice: { ...character.voice, age: "teen" } })).toMatch(
      /voice\.age/,
    );
  });

  it("rejects empty character look", () => {
    expect(errorsOf(Character, { ...character, look: "" })).toMatch(/look/);
  });
});

describe("characters and speakers (F11 acceptance 1)", () => {
  const dialogue = () =>
    script({
      characters: [character, son],
      shots: [
        shot({ line: "Open it after I leave.", onScreen: ["Mara", "Leo"] }),
        shot({ id: "s2", line: "Mom, are you sick?", speaker: "Leo", onScreen: ["Leo"] }),
      ],
      quotedLines: [],
    });

  it("accepts 1 and 2 characters", () => {
    expect(errorsOf(Script, script())).toBe("");
    const two = Script.parse(dialogue());
    expect(two.characters.map((c) => c.name)).toEqual(["Mara", "Leo"]);
    expect(two.shots.map((s) => s.speaker)).toEqual(["Mara", "Leo"]);
    expect(speakerOf(two, two.shots[1]!).name).toBe("Leo");
    expect(castOf(two, { ...two.shots[0]!, onScreen: ["Leo", "Mara"] }).map((c) => c.name)).toEqual(["Mara", "Leo"]);
  });

  it("rejects 0 or 3 characters, duplicate names and a missing voiceDescription", () => {
    expect(errorsOf(Script, script({ characters: [] }))).toMatch(/characters: a script has 1–2 characters, got 0/);
    const third = { ...son, name: "Ana" };
    expect(errorsOf(Script, script({ characters: [character, son, third] }))).toMatch(/1–2 characters, got 3/);
    expect(errorsOf(Script, script({ characters: [character, { ...son, name: "Mara" }] }))).toMatch(/unique; "Mara"/);
    const { voiceDescription: _, ...mute } = character;
    expect(errorsOf(Character, mute)).toMatch(/voiceDescription/);
  });

  it("rejects a spoken shot without a speaker", () => {
    const msg = errorsOf(Script, script({ shots: [shot({ speaker: undefined, seconds: 8 })] }));
    expect(msg).toMatch(/shots\.0\.speaker: shot s1 has a spoken line but no speaker/);
    expect(errorsOf(Script, script({ shots: [shot({ speaker: " ", seconds: 8 })] }))).toMatch(/no speaker/);
  });

  it("rejects an unknown speaker", () => {
    const msg = errorsOf(Script, script({ shots: [shot({ speaker: "Leo", onScreen: ["Leo"], seconds: 8 })] }));
    expect(msg).toMatch(/shots\.0\.speaker: shot s1: speaker "Leo" is not one of the characters \["Mara"\]/);
    expect(msg).toMatch(/onScreen "Leo" is not one of the characters/);
  });

  it("rejects a speaker who is not on screen", () => {
    const d = dialogue();
    (d.shots as z.input<typeof Shot>[])[1]!.onScreen = ["Mara"];
    expect(errorsOf(Script, d)).toMatch(/shots\.1\.onScreen: shot s2: speaker "Leo" must be in onScreen \["Mara"\]/);
    expect(errorsOf(Shot, shot({ onScreen: [] }))).toMatch(/onScreen must name at least one character/);
  });

  it("a silent shot needs no speaker", () => {
    expect(errorsOf(Script, script())).toBe("");
  });

  it("an old single-`character` script still parses and migrates", () => {
    const s = Script.parse(legacy());
    expect(s.characters).toHaveLength(1);
    expect(s.characters[0]!.name).toBe("Mara");
    expect(s.characters[0]!.voiceDescription).toBe("tired, warm female voice, young");
    expect(s.shots.map((x) => x.speaker)).toEqual(["Mara", undefined]);
    expect(s.shots.map((x) => x.onScreen)).toEqual([["Mara"], ["Mara"]]);
    expect(s).not.toHaveProperty("character");
    // Parsing is idempotent: a migrated script parses to itself.
    expect(Script.parse(s)).toEqual(s);
  });

  it("an old manifest with a single-`character` script still parses", () => {
    const m = RunManifest.parse({
      runId: "old",
      idea: "an idea",
      mode: "mock",
      createdAt: "2026-10-16T12:00:00.000Z",
      script: legacy(),
      attempts: [],
      costUsd: 0,
      ok: true,
    });
    expect(m.script?.characters[0]!.name).toBe("Mara");
    expect(m.script?.shots[0]!.speaker).toBe("Mara");
  });
});

describe("shot sizes and up to 4 shots (F12 acceptance 2)", () => {
  it("all six sizes parse; isWide is true for extreme wide / wide / full only", () => {
    for (const camera of CAMERAS) expect(errorsOf(Shot, shot({ camera }))).toBe("");
    expect(CAMERAS.filter(isWide)).toEqual(["extreme wide shot", "wide shot", "full shot"]);
  });

  it('"medium" migrates to "medium shot"', () => {
    expect(Shot.parse(shot({ camera: "medium" as never })).camera).toBe("medium shot");
    expect(Script.parse(script()).shots[1]!.camera).toBe("medium shot");
  });

  it("4 shots parse; ids must be s1..sN in order", () => {
    const four = (["s1", "s2", "s3", "s4"] as const).map((id) => shot({ id, seconds: 4, camera: "wide shot" }));
    expect(errorsOf(Script, script({ shots: four }))).toBe("");
    const swapped = [four[0]!, four[2]!, four[1]!, four[3]!];
    expect(errorsOf(Script, script({ shots: swapped }))).toMatch(/shot 2 must have id "s2", got "s3"/);
    expect(errorsOf(Script, script({ shots: [four[0]!, four[0]!] }))).toMatch(/shot 2 must have id "s2", got "s1"/);
  });

  it("a script with no line anywhere is rejected", () => {
    const silent = (["s1", "s2", "s3"] as const).map((id) => shot({ id, line: "", speaker: undefined, seconds: 4 }));
    expect(errorsOf(Script, script({ shots: silent }))).toMatch(/at least one shot must have a non-empty spoken line/);
  });

  it("an old manifest (pre-F12 camera, lip-sync fallback) still parses; voiceover and s3/s4 are new valid values", () => {
    const pass = { expected: "a", heard: "a", wer: 0, ops: [], pass: true };
    const base = { runId: "old", idea: "x", mode: "mock", createdAt: "2026-10-16T12:00:00.000Z", attempts: [], costUsd: 0, ok: true };
    const old = RunManifest.parse({
      ...base,
      script: script(),
      shots: { s2: { path: "b", seconds: 6, hasAudio: true, audio: "fallback", verbatim: pass } },
    });
    expect(old.script?.shots[1]!.camera).toBe("medium shot");
    const fresh = RunManifest.parse({
      ...base,
      shots: { s4: { path: "d", seconds: 6, hasAudio: true, audio: "voiceover", verbatim: pass } },
      attempts: [{ stage: "voiceover", shotId: "s3", n: 1, provider: "ffmpeg", ok: true, costUsd: 0, ms: 1 }],
    });
    expect(fresh.shots?.s4?.audio).toBe("voiceover");
  });
});

describe("Transcript", () => {
  it("accepts word timings and rejects end < start", () => {
    expect(
      Transcript.safeParse({ text: "hi bob", words: [{ word: "hi", start: 0, end: 0.3 }, { word: "bob", start: 0.3, end: 0.7 }] })
        .success,
    ).toBe(true);
    expect(errorsOf(Transcript, { text: "hi", words: [{ word: "hi", start: 0.5, end: 0.2 }] })).toMatch(
      /end must be >= start/,
    );
  });
});

describe("VerbatimResult", () => {
  it("rejects pass=true with a non-zero wer", () => {
    const bad = { expected: "a b", heard: "a", wer: 0.5, ops: [{ type: "del", expected: "b" }], pass: true };
    expect(errorsOf(VerbatimResult, bad)).toMatch(/pass must equal wer === 0/);
    expect(VerbatimResult.safeParse({ ...bad, pass: false }).success).toBe(true);
  });
});

describe("Attempt and RunManifest", () => {
  const attempt = { stage: "script", n: 1, provider: "mock-llm", ok: false, reason: "7 s total", costUsd: 0, ms: 12 };

  it("accepts a minimal manifest and a finished one", () => {
    expect(Attempt.safeParse(attempt).success).toBe(true);
    const base = {
      runId: "abc123",
      idea: "an idea",
      mode: "mock",
      createdAt: "2026-10-16T12:00:00.000Z",
      attempts: [attempt],
      costUsd: 0,
      ok: false,
      error: "boom",
    };
    expect(RunManifest.safeParse(base).success).toBe(true);
    const done = {
      ...base,
      ok: true,
      error: undefined,
      script: script(),
      final: { path: "runs/abc123/final.mp4", seconds: 9, width: 1080, height: 1920, hasAudio: true },
      verbatim: { expected: "meet me", heard: "meet me", wer: 0, ops: [], pass: true },
    };
    expect(RunManifest.safeParse(done).success).toBe(true);
  });

  it("rejects unknown mode, bad timestamp and negative cost", () => {
    const msg = errorsOf(RunManifest, {
      runId: "x",
      idea: "y",
      mode: "prod",
      createdAt: "yesterday",
      attempts: [{ ...attempt, costUsd: -1 }],
      costUsd: 0,
      ok: false,
    });
    expect(msg).toMatch(/mode/);
    expect(msg).toMatch(/createdAt/);
    expect(msg).toMatch(/attempts\.0\.costUsd/);
  });
});
