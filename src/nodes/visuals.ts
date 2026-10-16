/**
 * Visuals: identity anchor → keyframes → talking shots. Consistency comes from construction: the portrait is a
 * reference for every keyframe, the previous keyframe is a reference for the next, and each clip starts from its
 * keyframe. Native speech is never trusted: it goes through the verbatim gate, and when it keeps failing the shot
 * falls back to a verified TTS track lip-synced onto the best clip, so the words cannot drift.
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { trimArgs } from "../media/args.ts";
import { probe, run } from "../media/ffmpeg.ts";
import {
  PolicyRejectedError,
  type AsrProvider,
  type ImageProvider,
  type LipsyncProvider,
  type TtsProvider,
  type VideoProvider,
} from "../providers/index.ts";
import { keyframePrompt, portraitPrompt, talkingPrompt, VISUALS_PROMPT_VERSION } from "../prompts/visuals.ts";
import { withIssues } from "../prompts/judge.ts";
import type { Attempt, Script, Shot, VerbatimResult } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { splitDelivery } from "../verbatim.ts";
import { describeOps, listen, VerbatimError, verbatimOf, type ListenResult } from "./gate.ts";
import { verifiedVoice } from "./voice.ts";

export { keyframePrompt, portraitPrompt, talkingPrompt } from "../prompts/visuals.ts";

/** Smallest allowed clip length ≥ `seconds` (models bill and generate whole durations). Above the max → throws. */
export function snapDuration(seconds: number, durations: number[]): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`seconds must be > 0, got ${seconds}`);
  const fit = [...durations].sort((a, b) => a - b).find((d) => d >= seconds);
  if (fit === undefined) {
    throw new RangeError(`${seconds} s is longer than the longest allowed clip (${Math.max(...durations)} s)`);
  }
  return fit;
}

/** A shot that could not be produced. Carries the attempts so the manifest still tells the story. */
export class ShotError extends Error {
  constructor(
    readonly shotId: Shot["id"],
    message: string,
    readonly attempts: Attempt[],
    options?: { cause?: unknown },
  ) {
    super(`shot ${shotId}: ${message}`, options);
    this.name = "ShotError";
  }
}

export interface Still {
  path: string;
  attempts: Attempt[];
}

const ms = (t0: number): number => Math.round(performance.now() - t0);
/** Seconds for humans: at most 2 decimals ("7", "3.17"). */
const fmt = (s: number): string => String(Number(s.toFixed(2)));

async function still(
  stage: "portrait" | "keyframe",
  prompt: string,
  refs: string[],
  opts: { image: ImageProvider; dir: string; shotId?: Shot["id"]; variant?: number },
): Promise<Still> {
  const { image, dir, shotId, variant } = opts;
  const t0 = performance.now();
  // The variant joins the key only when set, so first attempts keep the paths (and caches) they had before F07.
  const v = variant ? [`variant:${variant}`] : [];
  const key = await contentKey(stage, image.name, VISUALS_PROMPT_VERSION, prompt, ...refs.map((file) => ({ file })), ...v);
  const name = shotId ? `${stage}-${shotId}-${key}.png` : `${stage}-${key}.png`;
  const made = await once(join(dir, name), (tmp) =>
    image.generate({ prompt, ...(refs.length ? { refs } : {}), out: tmp, ...(variant ? { variant } : {}) }),
  );
  return {
    path: made.path,
    attempts: [
      {
        stage,
        ...(shotId ? { shotId } : {}),
        n: (variant ?? 0) + 1,
        provider: image.name,
        ok: true,
        ...(made.cached ? { reason: "reused cached image" } : {}),
        costUsd: made.result?.costUsd ?? 0,
        ms: ms(t0),
      },
    ],
  };
}

/** The identity anchor: neutral light, face large, 9:16. */
export function castCharacter(script: Script, opts: { image: ImageProvider; dir: string }): Promise<Still> {
  return still("portrait", portraitPrompt(script), [], opts);
}

/**
 * A shot's first frame, generated with the portrait (and the previous keyframe, for continuity) as refs.
 * `issues` (from the quality judge, F07) are appended to the prompt; `variant` > 0 makes a new take.
 */
export function keyframeShot(
  shot: Shot,
  script: Script,
  portrait: string,
  prev: string | undefined,
  opts: { image: ImageProvider; dir: string; variant?: number; issues?: string[] },
): Promise<Still> {
  const { issues = [], ...rest } = opts;
  const prompt = withIssues(keyframePrompt(shot, script), issues);
  return still("keyframe", prompt, prev ? [portrait, prev] : [portrait], { ...rest, shotId: shot.id });
}

export interface TalkingShotOpts {
  script: Script;
  video: VideoProvider;
  asr: AsrProvider;
  tts: TtsProvider;
  lipsync: LipsyncProvider;
  dir: string;
  /** Total native video attempts before falling back to TTS + lip-sync. */
  maxNative?: number;
  /** Attempts for the fallback voice (F04). */
  maxVoice?: number;
  /**
   * 1-based take of the whole shot (F07: a regeneration after a low judge score is take 2). Later takes use new
   * video variants, so they make new files instead of hitting the cache of take 1.
   */
  take?: number;
  /** Judge issues from the previous take, appended to the video prompt. */
  issues?: string[];
  /** Measures every clip this node returns. ffprobe by default; injectable so tests can watch what gets measured. */
  probe?: (path: string) => Promise<{ seconds: number; hasAudio: boolean }>;
}

export interface TalkingShot {
  shotId: Shot["id"];
  path: string;
  seconds: number;
  hasAudio: boolean;
  /** How the words got there: none, the video model's own speech, or verified TTS + lip-sync. */
  via: "silent" | "native" | "lipsync";
  /** Gate result on the final clip (absent for silent shots). */
  verbatim?: VerbatimResult;
  speechStart?: number;
  speechEnd?: number;
  attempts: Attempt[];
}

interface Clip {
  path: string;
  seconds: number;
  hasAudio: boolean;
  costUsd: number;
  cached: boolean;
}

/** Silence kept after the last word when a clip is trimmed for lip-sync, so the line doesn't end on a hard cut. */
export const LIPSYNC_TRIM_TAIL = 0.4;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Every failure leaves with the attempts made so far: the manifest must show what was tried and paid for
 * (failed native takes, the voice take) even when a later step throws. ShotError and VerbatimError already
 * carry them; anything else (ASR outage, ffprobe, a bug) is wrapped here.
 */
export async function talkingShot(shot: Shot, keyframe: string, opts: TalkingShotOpts): Promise<TalkingShot> {
  const attempts: Attempt[] = [];
  try {
    return await produceTalkingShot(shot, keyframe, opts, attempts);
  } catch (e) {
    if (e instanceof ShotError || e instanceof VerbatimError) throw e;
    throw new ShotError(shot.id, errMsg(e), attempts, { cause: e });
  }
}

async function produceTalkingShot(shot: Shot, keyframe: string, opts: TalkingShotOpts, attempts: Attempt[]): Promise<TalkingShot> {
  const { script, video, asr, lipsync, dir, maxNative = 2, probe: measure = probe } = opts;
  if (maxNative < 1) throw new RangeError(`maxNative must be >= 1, got ${maxNative}`);
  const shotId = shot.id;
  const spoken = splitDelivery(shot.line).spoken;
  const seconds = snapDuration(shot.seconds, video.capabilities.durations);
  const prompt = withIssues(talkingPrompt(shot, script), opts.issues ?? []);
  const take = opts.take ?? 1;
  if (!Number.isInteger(take) || take < 1) throw new RangeError(`take must be an integer >= 1, got ${take}`);
  const record = (a: Omit<Attempt, "shotId">) => attempts.push({ ...a, shotId });
  /** Records the failed step, then throws with the full story. */
  const fail = (a: Omit<Attempt, "shotId" | "ok" | "reason">, reason: string, message: string, cause?: unknown): never => {
    record({ ...a, ok: false, reason });
    throw new ShotError(shotId, message, attempts, cause === undefined ? undefined : { cause });
  };

  /**
   * The base clip in a form the lip-sync model accepts. Over its `maxSeconds` → cut at the voice's speechEnd plus a
   * short tail (the voice is laid from t=0, so every word stays in); if even that is too long, fail with a reason
   * instead of cutting speech.
   */
  const fitForLipsync = async (clip: Clip, speechEnd: number): Promise<string> => {
    if (clip.seconds <= lipsync.maxSeconds) return clip.path;
    const t0 = performance.now();
    const target = Number((speechEnd + LIPSYNC_TRIM_TAIL).toFixed(3));
    const over = `${fmt(clip.seconds)} s clip > ${lipsync.name} max ${lipsync.maxSeconds} s`;
    const step = { stage: "trim", n: 1, provider: "ffmpeg", costUsd: 0 };
    if (target > lipsync.maxSeconds) {
      return fail(
        { ...step, ms: ms(t0) },
        `${over}; speech ends at ${fmt(speechEnd)} s, so even a ${fmt(target)} s trim is too long`,
        `${lipsync.name} accepts at most ${lipsync.maxSeconds} s of video, but the speech ends at ${fmt(speechEnd)} s ` +
          `(+${LIPSYNC_TRIM_TAIL} s tail); shorten the line or use a lip-sync provider with a higher limit`,
      );
    }
    const key = await contentKey("trim", { file: clip.path }, target);
    const cut = await once(join(dir, `trim-${shotId}-${key}.mp4`), (tmp) =>
      run(trimArgs({ input: clip.path, out: tmp, seconds: target })),
    );
    const cached = cut.cached ? "; reused cached trim" : "";
    const reason = `${over}; trimmed to ${fmt(target)} s (speech ends at ${fmt(speechEnd)} s + ${LIPSYNC_TRIM_TAIL} s)${cached}`;
    record({ ...step, ok: true, reason, ms: ms(t0) });
    return cut.path;
  };

  /** One video call (content-addressed). A provider error is recorded, then surfaces as a ShotError. */
  const animate = async (n: number, line: string | undefined): Promise<Clip> => {
    const variant = n - 1;
    const key = await contentKey("clip", video.name, VISUALS_PROMPT_VERSION, { file: keyframe }, prompt, line, seconds, variant);
    const t0 = performance.now();
    try {
      const made = await once(join(dir, `clip-${shotId}-${key}.mp4`), (tmp) =>
        video.animate({ image: keyframe, prompt, seconds, out: tmp, variant, ...(line ? { line } : {}) }),
      );
      // Length and audio come from the file, never from the adapter's report (hard rule 4). Only the cost is the
      // adapter's, since that is what the provider bills; a cached clip cost nothing this run.
      const { seconds: measured, hasAudio } = await measure(made.path);
      return { path: made.path, seconds: measured, hasAudio, costUsd: made.result?.costUsd ?? 0, cached: made.cached };
    } catch (e) {
      const policy = e instanceof PolicyRejectedError;
      // Not retried: the same keyframe and prompt would be rejected again. A human has to change the input.
      const reason = policy
        ? `rejected by content policy (${e.detail}); not retried with the same input`
        : `video error: ${(e as Error).message}`;
      record({ stage: "video", n, provider: video.name, ok: false, reason, costUsd: 0, ms: ms(t0) });
      throw new ShotError(
        shotId,
        policy ? `video provider ${video.name} ${reason}; change the keyframe or prompt` : reason,
        attempts,
        { cause: e },
      );
    }
  };

  if (spoken === "") {
    const t0 = performance.now();
    const clip = await animate(1, undefined);
    record({
      stage: "video",
      n: 1,
      provider: video.name,
      ok: true,
      reason: `silent shot: no verbatim gate${clip.cached ? "; reused cached clip" : ""}`,
      costUsd: clip.costUsd,
      ms: ms(t0),
    });
    return { shotId, path: clip.path, seconds: clip.seconds, hasAudio: clip.hasAudio, via: "silent", attempts };
  }

  /** `media` is the ffprobe measurement of `path` itself, so the reported length is the delivered file's. */
  const result = (
    path: string,
    media: { seconds: number; hasAudio: boolean },
    via: TalkingShot["via"],
    heard: ListenResult,
  ): TalkingShot => ({
    shotId,
    path,
    seconds: media.seconds,
    hasAudio: media.hasAudio,
    via,
    verbatim: verbatimOf(heard),
    speechStart: heard.speechStart,
    speechEnd: heard.speechEnd,
    attempts,
  });

  // 1–2. Native speech, gated.
  let best: { clip: Clip; wer: number } | undefined;
  const native = video.capabilities.nativeSpeech;
  const tries = native ? maxNative : 1;
  // Take k numbers its video calls after take k−1's, so variants (and attempt numbers) never collide.
  const first = (take - 1) * tries + 1;
  for (let n = first; n < first + tries; n++) {
    const t0 = performance.now();
    const clip = await animate(n, native ? shot.line : undefined);
    if (!native) {
      record({
        stage: "video",
        n,
        provider: video.name,
        ok: true,
        reason: `${video.name} has no native speech: base clip for TTS + lip-sync`,
        costUsd: clip.costUsd,
        ms: ms(t0),
      });
      best = { clip, wer: Infinity };
      break;
    }
    if (!clip.hasAudio) {
      // generate_audio is a request, not a guarantee. A silent take is a failed take: ASR can't listen to it (live
      // Groq extracts `-map 0:a:0` and throws), so don't call it. Keep the clip as a lip-sync base in case no take
      // speaks; any take with audio beats it (wer < Infinity).
      const reason = `no audio track${clip.cached ? "; reused cached clip" : ""}`;
      record({ stage: "video", n, provider: video.name, ok: false, reason, costUsd: clip.costUsd, ms: ms(t0) });
      best ??= { clip, wer: Infinity };
      continue;
    }
    let heard: ListenResult;
    try {
      heard = await listen(clip.path, shot.line, { asr });
    } catch (e) {
      // The clip was paid for even though it could not be checked: keep its cost in the record.
      const reason = `asr error on native clip: ${errMsg(e)}`;
      return fail({ stage: "video", n, provider: `${video.name}+${asr.name}`, costUsd: clip.costUsd, ms: ms(t0) }, reason, reason, e);
    }
    const reason = [...(clip.cached ? ["reused cached clip"] : []), ...(heard.pass ? [] : [describeOps(heard.ops) || "no speech heard"])];
    record({
      stage: "video",
      n,
      provider: `${video.name}+${asr.name}`,
      ok: heard.pass,
      ...(reason.length ? { reason: reason.join("; ") } : {}),
      costUsd: clip.costUsd + heard.costUsd,
      ms: ms(t0),
    });
    if (heard.pass) return result(clip.path, clip, "native", heard);
    if (!best || heard.wer < best.wer) best = { clip, wer: heard.wer };
  }

  // 3. Fallback: words from verified TTS, mouth from lip-sync on the closest native clip.
  record({
    stage: "fallback",
    n: 1,
    provider: `${opts.tts.name}+${lipsync.name}`,
    ok: true,
    reason: !native
      ? "no native speech; using verified TTS + lip-sync"
      : Number.isFinite(best!.wer)
        ? `native speech failed the verbatim gate ${tries}× (best wer ${best!.wer.toFixed(2)}); falling back to verified TTS + lip-sync`
        : `native speech failed ${tries}× (no take had an audio track); falling back to verified TTS + lip-sync`,
    costUsd: 0,
    ms: 0,
  });
  let voice;
  try {
    voice = await verifiedVoice(shot.line, script.character, {
      tts: opts.tts,
      asr,
      dir,
      emotion: shot.emotion,
      shotId,
      ...(opts.maxVoice ? { maxAttempts: opts.maxVoice } : {}),
    });
  } catch (e) {
    if (e instanceof VerbatimError) attempts.push(...e.attempts);
    throw new ShotError(shotId, `fallback voice failed: ${(e as Error).message}`, attempts, { cause: e });
  }
  attempts.push(...voice.attempts);

  const base = await fitForLipsync(best!.clip, voice.speechEnd);
  const t2 = performance.now();
  const lsProvider = `${lipsync.name}+${asr.name}`;
  const key = await contentKey("lipsync", lipsync.name, { file: base }, { file: voice.path });
  let synced;
  try {
    synced = await once(join(dir, `lipsync-${shotId}-${key}.mp4`), (tmp) =>
      lipsync.sync({ video: base, audio: voice.path, out: tmp }),
    );
  } catch (e) {
    const reason = `lip-sync error: ${errMsg(e)}`;
    return fail({ stage: "lipsync", n: 1, provider: lsProvider, costUsd: 0, ms: ms(t2) }, reason, `${reason} (${lipsync.name})`, e);
  }
  const syncCost = synced.result?.costUsd ?? 0;
  let heard: ListenResult;
  try {
    heard = await listen(synced.path, shot.line, { asr });
  } catch (e) {
    const reason = `asr error on lip-synced clip: ${errMsg(e)}`;
    return fail({ stage: "lipsync", n: 1, provider: lsProvider, costUsd: syncCost, ms: ms(t2) }, reason, reason, e);
  }
  record({
    stage: "lipsync",
    n: 1,
    provider: lsProvider,
    ok: heard.pass,
    ...(heard.pass ? (synced.cached ? { reason: "reused cached lip-sync" } : {}) : { reason: describeOps(heard.ops) || "no speech heard" }),
    costUsd: syncCost + heard.costUsd,
    ms: ms(t2),
  });
  if (!heard.pass) throw new VerbatimError(verbatimOf(heard), attempts, `lipsync ${shotId}`);
  // Lip-sync models may trim or pad the clip (Kling caps input at 10 s), so measure the synced file itself.
  return result(synced.path, await measure(synced.path), "lipsync", heard);
}
