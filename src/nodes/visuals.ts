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
import {
  keyframePrompt,
  OPENING_FRAME,
  portraitPrompt,
  talkingPrompt,
  textToVideoPrompt,
  VISUALS_PROMPT_VERSION,
} from "../prompts/visuals.ts";
import { withIssues } from "../prompts/judge.ts";
import { castOf, speakerOf, type Attempt, type Script, type Shot, type VerbatimResult } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { splitDelivery } from "../verbatim.ts";
import { describeIgnored, describeOps, listen, VerbatimError, verbatimOf, type ListenResult } from "./gate.ts";
import { verifiedVoice } from "./voice.ts";

export { keyframePrompt, portraitPrompt, talkingPrompt, textToVideoPrompt } from "../prompts/visuals.ts";
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

/**
 * Portrait files by character name. A single path is shorthand for a one-character script (every name maps to it),
 * which keeps single-character callers and tests unchanged.
 */
export type Portraits = string | Readonly<Record<string, string>>;

export function portraitOf(portraits: Portraits, name: string): string {
  if (typeof portraits === "string") return portraits;
  const p = portraits[name];
  if (p === undefined) throw new Error(`no portrait for character ${JSON.stringify(name)}`);
  return p;
}

/** Portraits of everyone on screen in a shot, speaker first, without repeats. */
export function shotPortraits(shot: Shot, script: Script, portraits: Portraits): { name: string; path: string }[] {
  const seen = new Set<string>();
  return castOf(script, shot)
    .map((c) => ({ name: c.name, path: portraitOf(portraits, c.name) }))
    .filter((p) => !seen.has(p.path) && Boolean(seen.add(p.path)));
}

/** One character's identity anchor (default: the first): the official headshot framing, 9:16. */
export function castCharacter(script: Script, opts: { image: ImageProvider; dir: string; name?: string }): Promise<Still> {
  const { name, ...rest } = opts;
  return still("portrait", portraitPrompt(script, name), [], rest);
}

/** Every character's portrait. Content-addressed per character (the prompt holds its name and look). */
export async function castCharacters(
  script: Script,
  opts: { image: ImageProvider; dir: string },
): Promise<{ portraits: Record<string, string>; attempts: Attempt[] }> {
  const portraits: Record<string, string> = {};
  const attempts: Attempt[] = [];
  for (const c of script.characters) {
    const r = await castCharacter(script, { ...opts, name: c.name });
    portraits[c.name] = r.path;
    attempts.push(...r.attempts);
  }
  return { portraits, attempts };
}

/**
 * A shot's first frame, generated with the portraits of everyone on screen (speaker first) and the previous keyframe
 * (continuity) as refs. `issues` (from the quality judge, F07) are appended to the prompt; `variant` > 0 makes a new take.
 */
export function keyframeShot(
  shot: Shot,
  script: Script,
  portraits: Portraits,
  prev: string | undefined,
  opts: { image: ImageProvider; dir: string; variant?: number; issues?: string[] },
): Promise<Still> {
  const { issues = [], ...rest } = opts;
  const prompt = withIssues(keyframePrompt(shot, script), issues);
  const refs = shotPortraits(shot, script, portraits).map((p) => p.path);
  return still("keyframe", prompt, prev ? [...refs, prev] : refs, { ...rest, shotId: shot.id });
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
  /**
   * The character portraits (a single path for a one-character script). Used only when the provider refuses the
   * keyframe as a first frame (real-face filter): the shot is then generated from references (the speaker's portrait
   * first, then other on-screen portraits, for identity; the keyframe last, for the scene), which the filter was seen
   * to accept on 2026-10-18.
   */
  portrait?: Portraits;
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
  const issues = opts.issues ?? [];
  const prompt = talkingPrompt(shot, script, { issues });
  /**
   * How the keyframe reaches the video model. `frame`: as the first frame (best). After a real-person refusal,
   * `refs`: no first frame; the speaker's portrait, other on-screen portraits, then the keyframe as references.
   * After another refusal, `text`: words only. The mode only ever steps down, and later takes of this shot keep it.
   */
  const ladder = ["frame", "refs", "text"] as const;
  let mode: (typeof ladder)[number] = "frame";
  const refList = [
    ...(opts.portrait ? shotPortraits(shot, script, opts.portrait).map((p) => ({ label: p.name, path: p.path })) : []),
    { label: OPENING_FRAME, path: keyframe },
  ];
  const refsFor = (): string[] => refList.map((r) => r.path);
  const promptFor = (m: typeof mode): string =>
    m === "frame" ? prompt : textToVideoPrompt(shot, script, { issues, ...(m === "refs" ? { refs: refList.map((r) => r.label) } : {}) });
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
    const p = promptFor(mode);
    const refs = mode === "refs" ? refsFor() : [];
    const input = mode === "frame" ? { file: keyframe } : mode;
    const key = await contentKey("clip", video.name, VISUALS_PROMPT_VERSION, input, ...refs.map((file) => ({ file })), p, line, seconds, variant);
    const t0 = performance.now();
    try {
      const made = await once(join(dir, `clip-${shotId}-${key}.mp4`), (tmp) =>
        video.animate({
          image: keyframe,
          prompt: p,
          seconds,
          out: tmp,
          variant,
          ...(line ? { line } : {}),
          ...(mode === "frame" ? {} : { textOnly: true }),
          ...(refs.length ? { refs } : {}),
        }),
      );
      // Length and audio come from the file, never from the adapter's report (hard rule 4). Only the cost is the
      // adapter's, since that is what the provider bills; a cached clip cost nothing this run.
      const { seconds: measured, hasAudio } = await measure(made.path);
      return { path: made.path, seconds: measured, hasAudio, costUsd: made.result?.costUsd ?? 0, cached: made.cached };
    } catch (e) {
      const policy = e instanceof PolicyRejectedError;
      const next = ladder[ladder.indexOf(mode) + 1];
      if (policy && e.realPerson && next) {
        // An input image, not the scene, was refused: step down to fewer images and try the same take again.
        // Identity then rests on the references, or only on the written look; the judge still compares to the portrait.
        record({
          stage: "video",
          n,
          provider: video.name,
          ok: false,
          reason: `${mode === "frame" ? "keyframe" : "reference images"} refused as a possible real person (${e.detail.slice(0, 160)}); retrying as ${next === "refs" ? "reference-to-video" : "text-to-video"}`,
          costUsd: 0,
          ms: ms(t0),
        });
        mode = next;
        return animate(n, line);
      }
      // Not retried: the same input would be rejected again. A human has to change it.
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
    const reason = [
      ...(clip.cached ? ["reused cached clip"] : []),
      ...(heard.pass ? [] : [describeOps(heard.ops) || "no speech heard"]),
      ...describeIgnored(heard),
    ];
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
    voice = await verifiedVoice(shot.line, speakerOf(script, shot), {
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
  const syncReason = [
    ...(heard.pass ? (synced.cached ? ["reused cached lip-sync"] : []) : [describeOps(heard.ops) || "no speech heard"]),
    ...describeIgnored(heard),
  ];
  record({
    stage: "lipsync",
    n: 1,
    provider: lsProvider,
    ok: heard.pass,
    ...(syncReason.length ? { reason: syncReason.join("; ") } : {}),
    costUsd: syncCost + heard.costUsd,
    ms: ms(t2),
  });
  if (!heard.pass) throw new VerbatimError(verbatimOf(heard), attempts, `lipsync ${shotId}`);
  // Lip-sync models may trim or pad the clip (Kling caps input at 10 s), so measure the synced file itself.
  return result(synced.path, await measure(synced.path), "lipsync", heard);
}
