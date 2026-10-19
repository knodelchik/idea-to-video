import { describe, expect, it } from "vitest";
import { parseSilence } from "../src/media/ffmpeg.ts";
import { finalGate } from "../src/nodes/final-gate.ts";
import type { AsrProvider } from "../src/providers/index.ts";
import { Script } from "../src/schemas.ts";

const STDERR = `[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 5.028 | silence_duration: 5.028
[silencedetect @ 0x1] silence_start: 17.9`;

describe("ASR hallucination in digital silence (live 2026-10-19)", () => {
  it("parseSilence reads closed and open spans", () => {
    expect(parseSilence(STDERR, 18.2)).toEqual([
      { start: 0, end: 5.028 },
      { start: 17.9, end: 18.2 },
    ]);
    expect(parseSilence("", 3)).toEqual([]);
  });

  const LINE = "You came back.";
  const script = Script.parse({
    promptVersion: "t",
    title: "t",
    logline: "t",
    setting: "a hall",
    characters: [{ name: "King", look: "grey beard, black fur mantle, iron crown, old man", voice: { gender: "male", age: "older", tone: "grave" }, voiceDescription: "deep old male voice" }],
    shots: [
      { id: "s1", camera: "wide shot", visual: "a castle", motion: "still", emotion: "calm", line: "", seconds: 5, onScreen: ["King"] },
      { id: "s2", camera: "medium shot", visual: "the king", motion: "still", emotion: "cold", line: LINE, seconds: 5, speaker: "King", onScreen: ["King"] },
    ],
    quotedLines: [LINE],
  });
  const w = (word: string, start: number) => ({ word, start, end: start + 0.3 });
  const asr: AsrProvider = {
    name: "fake-asr",
    transcribe: async () => ({
      text: "Thank you for watching! You came back.",
      words: [w("Thank", 1), w("you", 1.4), w("for", 1.8), w("watching!", 2.2), w("You", 6), w("came", 6.4), w("back.", 6.8)],
      costUsd: 0,
    }),
  };
  const probe = async () => ({ seconds: 10, width: 1080, height: 1920, hasAudio: true, hasVideo: true });

  it("words heard inside a silent span are dropped and reported; the rest must still be verbatim", async () => {
    const r = await finalGate("x.mp4", script, { asr, probe, silences: async () => [{ start: 0, end: 5 }] });
    expect(r.ok).toBe(true);
    expect(r.verbatim.wer).toBe(0);
    expect(r.attempts[0]!.reason).toMatch(/digital silence .*"Thank you for watching!"/);
  });

  it("without a silent span the same words fail the gate", async () => {
    const r = await finalGate("x.mp4", script, { asr, probe, silences: async () => [] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/ins "thank"/);
  });

  it("a word that really is spoken (outside silence) is never dropped", async () => {
    const r = await finalGate("x.mp4", script, { asr, probe, silences: async () => [{ start: 0, end: 1.2 }] });
    expect(r.ok).toBe(false); // only "Thank" sat in silence; "you for watching" still count
  });
});
