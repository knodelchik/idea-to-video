/**
 * Capability interfaces. Nodes depend on these, never on a vendor SDK. Every call that makes a file takes an
 * explicit `out` path (so the caller controls content-addressed naming) and every result carries `costUsd`
 * (0 for mocks) so the run manifest can account for every attempt.
 */
import type { z } from "zod";
import type { Transcript } from "../schemas.ts";

/**
 * What a provider knows about a call beyond its result (F16), read by the trace wrapper: the raw reply text, why the
 * model stopped (Gemini `finishReason`, `promptFeedback.blockReason`) and the token usage. Cheap to fill, never parsed.
 */
export interface CallMeta {
  text?: string;
  finishReason?: string;
  promptFeedback?: string;
  usage?: { input: number; output: number; thinking?: number };
}

export interface LlmRequest<T> {
  system: string;
  prompt: string;
  /** The shape we want back. The provider parses through it so failures come back as text we can re-prompt with. */
  schema: z.ZodType<T>;
  temperature?: number;
}

/** Not thrown on a bad shape: the caller needs the cost and the error text to retry. */
export type LlmResult<T> = (
  | { ok: true; data: T; raw: unknown; costUsd: number }
  | { ok: false; error: string; raw: unknown; costUsd: number }
) & {
  /** Model that actually answered, when the provider has a model chain. */
  model?: string;
  /** Fallbacks or caveats the caller must record in the manifest (no silent fallbacks). */
  notes?: string[];
  meta?: CallMeta;
};

/**
 * Every capability may say what a call would cost *before* making it (USD, upper-ish bound). The budget guard
 * (`withBudget`) refuses a call whose estimate would push the run past MAX_COST_USD. Absent = free (mocks).
 */
export interface LlmProvider {
  readonly name: string;
  generateJson<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
  estimateUsd?(req: { system: string; prompt: string }): number;
}

export interface TtsRequest {
  text: string;
  voice: string;
  out: string;
  /** Retry number; lets a provider change seed/settings between attempts. */
  variant?: number;
  /**
   * Delivery ("whispers", "hopeful disbelief"). Goes to the provider as a setting or an audio tag, never into
   * `text`: `text` is exactly what the verbatim gate expects to hear.
   */
  emotion?: string;
}
export interface TtsResult {
  path: string;
  seconds: number;
  costUsd: number;
  /** Which concrete engine spoke, when the provider is a chain. */
  provider?: string;
  /** Fallbacks or caveats the caller must record in the manifest (no silent fallbacks). */
  notes?: string[];
}
export interface TtsProvider {
  readonly name: string;
  speak(req: TtsRequest): Promise<TtsResult>;
  estimateUsd?(req: TtsRequest): number;
}

/** `model`: the model id that answered (F17, for the trace); `seconds`: the audio length it billed. */
export type AsrResult = Transcript & { costUsd: number; model?: string; seconds?: number };
export interface AsrProvider {
  readonly name: string;
  transcribe(req: { path: string }): Promise<AsrResult>;
  estimateUsd?(req: { path: string }): number;
}

export interface ImageRequest {
  prompt: string;
  /** Reference images (character portrait, previous keyframe) for consistency. */
  refs?: string[];
  out: string;
  variant?: number;
}
/** `model`: the model id that drew it (F17, for the trace). */
export interface ImageResult {
  path: string;
  costUsd: number;
  model?: string;
}
/** Always 9:16. */
export interface ImageProvider {
  readonly name: string;
  generate(req: ImageRequest): Promise<ImageResult>;
  estimateUsd?(req: ImageRequest): number;
}

export interface VideoCapabilities {
  /** The model can speak a given line itself (e.g. Seedance 2.0 with audio). */
  nativeSpeech: boolean;
  /** Clip lengths the model accepts, seconds, ascending. */
  durations: number[];
}
export interface AnimateRequest {
  image: string;
  prompt: string;
  seconds: number;
  out: string;
  /** Exact text the character must say when the model speaks natively. */
  line?: string;
  refs?: string[];
  variant?: number;
  /**
   * Text-to-video: `image` is not sent. Used after a provider rejected the keyframe as a possible real person
   * (Seedance's real-face filter); the prompt then has to describe the character and setting itself.
   */
  textOnly?: boolean;
  /** Ladder rung that made this request, for the trace (F16). Providers ignore it. */
  mode?: "frame" | "refs" | "portraits" | "text";
}
export interface AnimateResult {
  path: string;
  seconds: number;
  hasAudio: boolean;
  costUsd: number;
  /** The model id that rendered it (F17, for the trace). */
  model?: string;
}
export interface VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities;
  animate(req: AnimateRequest): Promise<AnimateResult>;
  estimateUsd?(req: AnimateRequest): number;
}

export interface LipsyncProvider {
  readonly name: string;
  /**
   * Longest input clip the model accepts, seconds (Infinity = no documented limit). The caller trims a longer
   * clip after the speech ends, or fails with a reason; it must never silently cut speech.
   */
  readonly maxSeconds: number;
  sync(req: { video: string; audio: string; out: string }): Promise<{ path: string; costUsd: number; model?: string }>;
  estimateUsd?(req: { video: string; audio: string; out: string }): number;
}

/** Audio-driven avatar models: image + speech → talking clip. */
export interface TalkingProvider {
  readonly name: string;
  talk(req: { image: string; audio: string; prompt: string; out: string }): Promise<{ path: string; costUsd: number; model?: string }>;
  estimateUsd?(req: { image: string; audio: string; prompt: string; out: string }): number;
}

export interface JudgeImageRequest {
  path: string;
  rubric: string;
  /** Reference images (the character portrait) the judged image must match. */
  refs?: string[];
}
export interface JudgeVideoRequest {
  /** Frames sampled evenly from the clip, in order. The fallback when the clip itself can't be sent (F14). */
  frames: string[];
  rubric: string;
  refs?: string[];
  /** The clip itself (mp4). A provider that can watch video judges this instead of `frames` (F14). */
  video?: string;
  /** Clip length in seconds, for the cost estimate of a video request. */
  seconds?: number;
}
/** Parsed through `JudgeVerdict`. A reply that fails it makes the provider throw `JudgeOutputError` (with its cost). */
export interface JudgeResult {
  score: number;
  issues: string[];
  costUsd: number;
  /** Model that answered, and fallbacks the caller must record. */
  model?: string;
  notes?: string[];
  meta?: CallMeta;
}
/** A VLM that scores images and clips (F07). It judges only what code can't check. */
export interface JudgeProvider {
  readonly name: string;
  judgeImage(req: JudgeImageRequest): Promise<JudgeResult>;
  judgeVideo(req: JudgeVideoRequest): Promise<JudgeResult>;
  /** `videoSeconds`: a clip sent as video, priced per sampled frame plus audio. */
  estimateUsd?(req: { images: number; rubric: string; videoSeconds?: number }): number;
}

export interface Providers {
  llm: LlmProvider;
  tts: TtsProvider;
  asr: AsrProvider;
  image: ImageProvider;
  video: VideoProvider;
  lipsync: LipsyncProvider;
  talking: TalkingProvider;
  judge: JudgeProvider;
}
