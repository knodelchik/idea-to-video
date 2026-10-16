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
  formatIssues,
} from "../src/schemas.ts";

const character = {
  name: "Mara",
  look: "woman in her late 20s, short black bob, freckles, green apron over a grey t-shirt",
  voice: { gender: "female", age: "young", tone: "tired, warm" },
} as const;

const shot = (over: Partial<z.input<typeof Shot>> = {}): z.input<typeof Shot> => ({
  id: "s1",
  camera: "close-up",
  visual: "she unfolds a note at the counter",
  motion: "slow push-in",
  emotion: "surprised, then moved",
  line: "Meet me where it started.",
  seconds: 5,
  ...over,
});

const script = (over: Partial<z.input<typeof Script>> = {}): z.input<typeof Script> => ({
  promptVersion: "script-v1",
  title: "The Note",
  logline: "A barista finds a note in the tip jar.",
  setting: "small café at closing time",
  character,
  shots: [shot(), shot({ id: "s2", camera: "medium", line: "", seconds: 4 })],
  quotedLines: ["Meet me where it started."],
  ...over,
});

/** Parse and return the readable error text, or "" when valid. */
const errorsOf = (schema: z.ZodType, value: unknown): string => {
  const r = schema.safeParse(value);
  return r.success ? "" : formatIssues(r.error);
};

describe("Script", () => {
  it("accepts a valid two-shot script", () => {
    const parsed = Script.parse(script());
    expect(parsed.shots).toHaveLength(2);
    expect(parsed.character.voice.gender).toBe("female");
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

  it("rejects 3 shots with a readable message", () => {
    const msg = errorsOf(
      Script,
      script({ shots: [shot({ seconds: 4 }), shot({ id: "s2", seconds: 4 }), shot({ id: "s2", seconds: 4 })] }),
    );
    expect(msg).toMatch(/shots: a script has 1–2 shots, got 3/);
  });

  it("rejects 0 shots", () => {
    expect(errorsOf(Script, script({ shots: [] }))).toMatch(/a script has 1–2 shots, got 0/);
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
