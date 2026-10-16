/**
 * Capability interfaces. Nodes depend on these, never on a vendor SDK. Every call that makes a file takes an
 * explicit `out` path (so the caller controls content-addressed naming) and every result carries `costUsd`
 * (0 for mocks) so the run manifest can account for every attempt.
 */
import type { z } from "zod";
import type { Transcript } from "../schemas.ts";

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
};

export interface LlmProvider {
  readonly name: string;
  generateJson<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
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
}

export type AsrResult = Transcript & { costUsd: number };
export interface AsrProvider {
  readonly name: string;
  transcribe(req: { path: string }): Promise<AsrResult>;
}

export interface ImageRequest {
  prompt: string;
  /** Reference images (character portrait, previous keyframe) for consistency. */
  refs?: string[];
  out: string;
  variant?: number;
}
/** Always 9:16. */
export interface ImageProvider {
  readonly name: string;
  generate(req: ImageRequest): Promise<{ path: string; costUsd: number }>;
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
}
export interface AnimateResult {
  path: string;
  seconds: number;
  hasAudio: boolean;
  costUsd: number;
}
export interface VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities;
  animate(req: AnimateRequest): Promise<AnimateResult>;
}

export interface LipsyncProvider {
  readonly name: string;
  sync(req: { video: string; audio: string; out: string }): Promise<{ path: string; costUsd: number }>;
}

/** Audio-driven avatar models: image + speech → talking clip. */
export interface TalkingProvider {
  readonly name: string;
  talk(req: { image: string; audio: string; prompt: string; out: string }): Promise<{ path: string; costUsd: number }>;
}

export interface Providers {
  llm: LlmProvider;
  tts: TtsProvider;
  asr: AsrProvider;
  image: ImageProvider;
  video: VideoProvider;
  lipsync: LipsyncProvider;
  talking: TalkingProvider;
}
