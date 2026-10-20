/**
 * F20: the failure explanation on the two real live failures. Both runs were rescued by `--redo`, so their manifests
 * in tests/fixtures/live-manifests are `ok: true`; each test rebuilds the failed state the reviewer would have seen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunManifest, type Attempt } from "../src/schemas.ts";
import { GATE_VERSION } from "../src/verbatim.ts";
import { explainFailure, opsInWords, stepOf, videoUsdPerSecond } from "../src/web/explain.ts";

const FIX = join(import.meta.dirname, "fixtures", "live-manifests");
const load = (id: string): RunManifest => RunManifest.parse(JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8")));

/** The run as it stood when it failed: these attempts, no s2 output, nothing final. */
function failedState(m: RunManifest, attempts: Attempt[], error: string): RunManifest {
  const { s2: _gone, ...shots } = m.shots ?? {};
  const { final: _f, verbatim: _v, spoken: _s, subtitles: _t, redos: _r, ...rest } = m;
  return RunManifest.parse({ ...rest, shots, attempts, costUsd: attempts.reduce((s, a) => s + a.costUsd, 0), ok: false, status: "failed", error });
}

const uncarry = (as: Attempt[]): Attempt[] => as.map(({ carried: _c, ...a }) => a);
const marks = (ws: { word: string; mark?: string }[]) => ws.filter((w) => w.mark).map((w) => `${w.mark}:${w.word}`);

describe("explainFailure on a20fab (2026-10-20, $2.9)", () => {
  const m = load("20261020-073411-a20fab");
  // attempts[0..10]: script → keyframe judges, the fork the redo started from. attempts[21..28]: the first pass's
  // paid shot attempts, carried by the redo. Its $0 attempts (fallback, voiceover) were not carried, so the two that
  // ended the run are rebuilt here from the run's recorded error.
  const fork = m.attempts.slice(0, 11);
  const firstPass = uncarry(m.attempts.slice(21));
  expect(firstPass.map((a) => `${a.stage}:${a.shotId}:${a.ok}`)).toEqual([
    "video:s1:true", "listen:s1:true", "judge:s1:true", "video:s3:true", "judge:s3:true", "video:s2:false", "video:s2:false", "voice:s2:true",
  ]);
  const s2Video = firstPass.slice(0, 7);
  const fallback: Attempt = { stage: "fallback", shotId: "s2", n: 1, provider: "gemini-tts", ok: true, reason: "native speech failed the verbatim gate 2× (best wer 0.13); falling back to verified TTS as a voice-over without lip-sync (the clip has cuts: faces change between them)", costUsd: 0, ms: 0 };
  const voiceover: Attempt = { stage: "voiceover", shotId: "s2", n: 1, provider: "ffmpeg+groq-whisper", ok: false, reason: "voice speech ends at 10.42 s, after the 9.09 s clip", costUsd: 0, ms: 3 };
  const LONG = "shot s2: the verified voice (10.42 s of speech) is longer than the 9.09 s clip; lengthen the shot or shorten the line";

  it("the real failure: the voice-over is longer than the clip; continue from shot s2, re-gated, ~$0.01", () => {
    const x = explainFailure(failedState(m, [...fork, ...s2Video, fallback, firstPass[7]!, voiceover], LONG));
    expect(x).toMatchObject({ kind: "voiceTooLong", step: "shot", shotId: "s2", freshTakes: false, estimateUsd: 0.01 });
    expect(x.what).toMatch(/^Shot s2: /);
    expect(x.why).toMatch(/10\.42 s but the clip is 9\.09 s/);
    expect(x.finished.map((f) => f.shotId).sort()).toEqual(["s1", "s3"]);
    expect(x.error).toBe(LONG);
  });

  it("verbatim-only variant (ends at the second failed s2 take): kind, step, shot and a diff marking for/dollars", () => {
    const err = 'shot s2: video s2: not verbatim after 2 attempts (wer 0.13): sub "four" heard as "for", ins "dollars" (extra)';
    const x = explainFailure(failedState(m, [...fork, ...s2Video], err));
    expect(x).toMatchObject({ kind: "verbatim", step: "shot", shotId: "s2" });
    expect(x.what).toBe("Shot s2: the spoken line was not word-for-word, so the agent refused to ship it.");
    expect(x.why).toMatch(/heard "for" where the line says "four" and an extra "dollars"\./);
    expect(marks(x.diff!.heard)).toEqual(["sub:for", "ins:dollars"]);
    expect(marks(x.diff!.expected)).toEqual(["sub:four"]);
    expect(x.diff!.approx).toBe(true);
    expect(x.heard).toMatch(/for fifty dollars/);
    expect(x.expected).toMatch(/^Ticket's \$4\.50/);
    // Judged by a gate before GATE_VERSION was recorded: the saved takes are re-gated, no new video.
    expect(x.freshTakes).toBe(false);
    expect(x.estimateUsd).toBe(0.01);
    expect(x.next).toMatch(/re-runs it on the saved takes/);
  });

  it("the same takes judged by the current gate: continue makes new takes, priced from what this run paid", () => {
    const current = s2Video.map((a) => (a.shotId === "s2" && a.stage === "video" ? { ...a, gateVersion: GATE_VERSION } : a));
    const err = 'shot s2: video s2: not verbatim after 2 attempts (wer 0.13): sub "four" heard as "for", ins "dollars" (extra)';
    const state = failedState(m, [...fork, ...current], err);
    const x = explainFailure(state);
    expect(x.freshTakes).toBe(true);
    // $2.738 paid for 30 s of video (5 + 7 + 9 + 9) → $0.0913/s; s2 is 8.5 s → 9 s of new video + $0.01.
    expect(videoUsdPerSecond(state, 1)).toBeCloseTo(2.7378 / 30, 4);
    expect(x.estimateUsd).toBeCloseTo(Number((9 * (2.7378 / 30) + 0.01).toFixed(2)), 2);
    expect(x.next).toMatch(/^Continue makes new takes of this shot \(~\$0\.8\d\); shots that passed are reused for \$0\.$/);
  });

  it("interrupted after a failed take (current gate) is interrupted: resume the checkpoint, no fresh takes", () => {
    const oneMiss = { ...s2Video[5]!, gateVersion: GATE_VERSION };
    for (const error of ["interrupted by SIGTERM", "interrupted: the run's process ended before it finished", "crashed: boom"]) {
      const x = explainFailure(failedState(m, [...fork, ...s2Video.slice(0, 5), oneMiss], error));
      expect(x, error).toMatchObject({ kind: "interrupted", step: null, freshTakes: false, estimateUsd: 0.01 });
      expect(x.what).not.toMatch(/refused/);
      expect(x.next).toMatch(/resumes the run where it stopped/);
    }
  });
});

describe("explainFailure on 6f4903 (2026-10-19, $2.88)", () => {
  const m = load("20261019-121918-6f4903");
  // The manifest was rewritten by a redo before F19 carried attempts, so the refused s2 takes are gone. They are rebuilt
  // from what Whisper heard on that run (tests/fixtures/asr-live.jsonl) and the ops the gate of the day gave.
  const before = m.attempts.slice(0, 13);
  const ops = 'sub "ticket\'s" heard as "tickets", sub "kyiv" heard as "kiev"';
  const take = (n: number): Attempt => ({ stage: "video", shotId: "s2", n, provider: "openrouter-seedance-2.0-fast+groq-whisper", ok: false, reason: ops, costUsd: 0.82, ms: 1 });
  const voice = (n: number): Attempt => ({ stage: "voice", shotId: "s2", n, provider: "gemini-tts+groq-whisper", ok: false, reason: ops, costUsd: 0.003, ms: 1 });
  const err = `shot s2: fallback voice failed: voice: not verbatim after 3 attempts (wer 0.13): ${ops}`;

  it("Kyiv/Kiev and ticket's/tickets: verbatim at shot s2, both words marked", () => {
    const x = explainFailure(failedState(m, [...before, take(1), take(2), voice(1), voice(2), voice(3)], err));
    expect(x).toMatchObject({ kind: "verbatim", step: "shot", shotId: "s2", freshTakes: false });
    expect(marks(x.diff!.expected)).toEqual(["sub:ticket's", "sub:kyiv"]);
    expect(marks(x.diff!.heard)).toEqual(["sub:tickets", "sub:kiev"]);
    expect(x.why).toMatch(/2 native takes were checked/);
  });
});

describe("explainFailure: other kinds and the fallback", () => {
  const base = load("20261020-073411-a20fab");
  const fork = base.attempts.slice(0, 11);
  const with_ = (attempts: Attempt[], error: string) => failedState(base, [...fork, ...attempts], error);
  const a = (stage: string, extra: Partial<Attempt> = {}): Attempt => ({ stage, n: 1, provider: "p", ok: false, costUsd: 0, ms: 0, ...extra });

  it("budget, refused, provider, judge, interrupted, unknown each have plain words and a step", () => {
    const budget = explainFailure(with_([a("video", { shotId: "s2", reason: "video error: budget: x call would cost ~$0.9 on top of $2.5 (MAX_COST_USD $3)" })], "shot s2: video error: budget: openrouter call would cost ~$0.9000 on top of $2.5000 (MAX_COST_USD $3)"));
    expect(budget).toMatchObject({ kind: "budget", step: "shot", shotId: "s2" });
    expect(budget.next).toBe("Continue retries from shot; everything finished is reused.");
    expect(budget.estimateUsd).toBeGreaterThan(0.5); // s2 never got a clip: new video is needed

    const refused = explainFailure(with_([a("video", { shotId: "s2", reason: "rejected by content policy (real person); not retried with the same input" })], "shot s2: video provider x rejected by content policy (real person); not retried with the same input; change the keyframe or prompt"));
    expect(refused).toMatchObject({ kind: "refused", step: "shot" });
    expect(refused.what).toMatch(/content policy/);

    const provider = explainFailure(with_([a("retry", { reason: "transient error in drawKeyframes (try 3/3): HTTP 503; giving up" })], "HTTP 503 from image provider"));
    expect(provider).toMatchObject({ kind: "provider", step: "drawKeyframes" });

    const judge = explainFailure(with_([a("judge", { shotId: "s1", reason: "keyframe score 3/10 < 7" })], "keyframe judge: score 3/10 below the bar"));
    expect(judge).toMatchObject({ kind: "judge", step: "drawKeyframes" });

    const stopped = explainFailure(with_([], "interrupted by SIGTERM"));
    expect(stopped).toMatchObject({ kind: "interrupted", step: null });
    expect(stopped.next).toMatch(/resumes the run where it stopped/);

    const odd = explainFailure(with_([], "something nobody planned for"));
    expect(odd).toMatchObject({ kind: "unknown", error: "something nobody planned for" });
    expect(odd.title.length).toBeGreaterThan(0);
    expect(odd.what.length).toBeGreaterThan(0);
  });

  it("a failure recorded with a transcript gets the exact diff, not a reconstruction", () => {
    const x = explainFailure(with_([a("video", { shotId: "s2", reason: 'del "anyone" (missing)', gateVersion: GATE_VERSION, heard: "Ticket's $4.50, and this train left Kyiv in 1987, it doesn't stop for" })], 'shot s2: video s2: not verbatim after 1 attempts (wer 0.05): del "anyone" (missing)'));
    expect(x.diff!.approx).toBeUndefined();
    expect(marks(x.diff!.expected)).toEqual(["del:anyone"]);
    expect(x.heard).toMatch(/^Ticket's \$4\.50/);
    expect(x.freshTakes).toBe(true);
  });

  it("stepOf maps stages to graph steps; opsInWords reads like a sentence", () => {
    expect(["script", "portrait", "keyframe", "video", "listen", "voiceover", "lipsync", "assemble", "subtitles", "final"].map((stage) => stepOf(a(stage)))).toEqual([
      "writeScript", "cast", "drawKeyframes", "shot", "shot", "shot", "shot", "assemble", "burnSubtitles", "finalGate",
    ]);
    expect(stepOf(a("judge", { reason: "clip score 2/10 < 5" }))).toBe("shot");
    expect(opsInWords([{ type: "del", expected: "anyone" }])).toBe('nothing for "anyone"');
  });
});
