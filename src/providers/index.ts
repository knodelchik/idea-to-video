/**
 * The only door from nodes to providers (CLAUDE.md rule 7). `mock` is free and deterministic; `live` adapters
 * arrive in later features and until then fail loudly, naming the env var that would configure them.
 */
import { MockAsr, MockImage, MockJudge, MockLipsync, MockLlm, MockTalking, MockTts, MockVideo, mockScriptResponder } from "./mock.ts";
import type { Providers } from "./types.ts";
import { GeminiLlm } from "./gemini.ts";
import { GeminiTts } from "./gemini-tts.ts";
import { ElevenLabsTts } from "./elevenlabs.ts";
import { GroqAsr } from "./groq-asr.ts";
import { TtsChain } from "./tts-chain.ts";
import type { FetchLike } from "./http.ts";
import { NotConfiguredError } from "./errors.ts";
import { seedanceFromEnv } from "./seedance.ts";
import { imageFromEnv } from "./image.ts";
import { lipsyncFromEnv } from "./lipsync.ts";
import { GeminiJudge } from "./gemini-judge.ts";

const SELF_CONFIGURED = new Set<keyof Providers>(["tts", "image", "video", "lipsync"]);

export type * from "./types.ts";
export {
  MockAsr,
  MockImage,
  MockLipsync,
  MockLlm,
  MockTalking,
  MockTts,
  MockVideo,
  MOCK_DEFAULT_LINE,
  MOCK_JUDGE_SCORE,
  MockJudge,
  mockScriptResponder,
} from "./mock.ts";
export type { JudgeScript } from "./mock.ts";
export { DEFAULT_JUDGE_MODELS, GeminiJudge, JUDGE_SYSTEM } from "./gemini-judge.ts";
export { Budget, BudgetExceededError, DEFAULT_MAX_COST_USD, maxCostFromEnv, withBudget } from "./budget.ts";
export type { AsrFault, Responder, VideoFault } from "./mock.ts";
export { GeminiTts, ElevenLabsTts, GroqAsr, TtsChain };
export { HttpError, isTransient as isTransientHttp, type FetchLike } from "./http.ts";
export { JudgeOutputError, NotConfiguredError, PolicyRejectedError } from "./errors.ts";
export { BytePlusSeedance, FalSeedance, SeedanceVideo, seedanceFromEnv, SEEDANCE_DURATIONS } from "./seedance.ts";
export { FalNanoBananaImage, GeminiImage, SeedreamImage, imageFromEnv } from "./image.ts";
export { CommandLipsync, FalKlingLipsync, lipsyncFromEnv } from "./lipsync.ts";
export type { FalLike } from "./fal.ts";
export { FalKlingAvatar, KLING_AVATAR_ENDPOINTS, KLING_AVATAR_USD_PER_SECOND, klingAvatarFromEnv, type KlingAvatarTier } from "./talking.ts";
export { KLING_LIPSYNC_MAX_SECONDS, klingLipsyncCost } from "./lipsync.ts";
export { FAL_SEEDANCE_USD_PER_SECOND } from "./seedance.ts";
export { FAL_NANO_BANANA_USD } from "./image.ts";

export type Env = Record<string, string | undefined>;

/**
 * Default env var each live capability needs (per specs F03–F05). Checked in this order. image / video / lipsync
 * pick their key from IMAGE_PROVIDER / SEEDANCE_TRANSPORT / LIPSYNC_PROVIDER, so their *FromEnv names it.
 */
export const LIVE_ENV: Record<keyof Providers, string> = {
  llm: "GEMINI_API_KEY",
  tts: "GEMINI_API_KEY",
  asr: "GROQ_API_KEY",
  image: "FAL_KEY",
  video: "FAL_KEY",
  lipsync: "FAL_KEY",
  talking: "FAL_KEY",
  judge: "GEMINI_API_KEY",
};

/** TTS engines by name → the env var holding their key. */
export const TTS_KEYS: Record<string, string> = { gemini: "GEMINI_API_KEY", elevenlabs: "ELEVENLABS_API_KEY" };
export const DEFAULT_TTS_PROVIDERS = "gemini,elevenlabs";

/**
 * Live TTS in TTS_PROVIDERS order. A provider without a key is skipped (configuration, not a runtime fallback);
 * none left → NotConfiguredError. An unknown name is a typo and fails loudly.
 */
export function ttsFromEnv(env: Env, deps: { fetch?: FetchLike } = {}): TtsChain {
  const names = (env.TTS_PROVIDERS || DEFAULT_TTS_PROVIDERS)
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !(n in TTS_KEYS));
  if (unknown.length) {
    throw new Error(`TTS_PROVIDERS: unknown provider(s) ${unknown.join(", ")}; known: ${Object.keys(TTS_KEYS).join(", ")}`);
  }
  const usable = names.filter((n) => env[TTS_KEYS[n]!]);
  if (usable.length === 0) throw new NotConfiguredError("tts", names.map((n) => TTS_KEYS[n]).join(" or "));
  return new TtsChain(usable.map((n) => (n === "gemini" ? GeminiTts.fromEnv(env, deps) : ElevenLabsTts.fromEnv(env, deps))));
}

export interface CreateProvidersOpts {
  mode: "mock" | "live";
  env: Env;
  /** Replace individual providers (tests inject fault-injecting mocks or a canned LLM). */
  overrides?: Partial<Providers>;
}

export function createProviders({ mode, env, overrides = {} }: CreateProvidersOpts): Providers {
  if (mode === "mock") {
    return {
      // Scripted so a bare `pnpm make --mock` works; tests that need specific scripts override `llm`.
      llm: new MockLlm({ responder: mockScriptResponder }),
      tts: new MockTts(),
      asr: new MockAsr(),
      image: new MockImage(),
      video: new MockVideo(),
      lipsync: new MockLipsync(),
      talking: new MockTalking(),
      judge: new MockJudge(),
      ...overrides,
    };
  }
  for (const [capability, envVar] of Object.entries(LIVE_ENV) as [keyof Providers, string][]) {
    // These choose their key from env (TTS_PROVIDERS, IMAGE_PROVIDER, …); their *FromEnv names the missing one.
    if (overrides[capability] || SELF_CONFIGURED.has(capability)) continue;
    if (!env[envVar]) throw new NotConfiguredError(capability, envVar);
  }
  const live: Partial<Providers> = {
    ...overrides,
    llm: overrides.llm ?? GeminiLlm.fromEnv(env),
    tts: overrides.tts ?? ttsFromEnv(env),
    asr: overrides.asr ?? GroqAsr.fromEnv(env),
    image: overrides.image ?? imageFromEnv(env),
    video: overrides.video ?? seedanceFromEnv(env),
    lipsync: overrides.lipsync ?? lipsyncFromEnv(env),
    judge: overrides.judge ?? GeminiJudge.fromEnv(env),
  };
  // Keys are present but no live adapter exists yet; still refuse rather than silently using a mock.
  const missing = (Object.keys(LIVE_ENV) as (keyof Providers)[]).find((c) => !live[c]);
  if (missing) throw new NotConfiguredError(missing, `a live ${missing} adapter (not implemented yet)`);
  return live as Providers;
}
