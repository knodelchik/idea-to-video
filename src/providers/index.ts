/**
 * The only door from nodes to providers (CLAUDE.md rule 7). `mock` is free and deterministic; `live` adapters
 * arrive in later features and until then fail loudly, naming the env var that would configure them.
 */
import { MockAsr, MockImage, MockLipsync, MockLlm, MockTalking, MockTts, MockVideo } from "./mock.ts";
import type { Providers } from "./types.ts";
import { GeminiLlm } from "./gemini.ts";

export type * from "./types.ts";
export { MockAsr, MockImage, MockLipsync, MockLlm, MockTalking, MockTts, MockVideo } from "./mock.ts";
export type { AsrFault, Responder, VideoFault } from "./mock.ts";

export class NotConfiguredError extends Error {
  constructor(
    readonly capability: keyof Providers,
    readonly envVar: string,
  ) {
    super(`live ${capability} provider is not configured: set ${envVar}`);
    this.name = "NotConfiguredError";
  }
}

export type Env = Record<string, string | undefined>;

/** Env var each live capability will need (per specs F03–F05). Checked in this order. */
export const LIVE_ENV: Record<keyof Providers, string> = {
  llm: "GEMINI_API_KEY",
  tts: "GEMINI_API_KEY",
  asr: "GROQ_API_KEY",
  image: "FAL_KEY",
  video: "FAL_KEY",
  lipsync: "FAL_KEY",
  talking: "FAL_KEY",
};

export interface CreateProvidersOpts {
  mode: "mock" | "live";
  env: Env;
  /** Replace individual providers (tests inject fault-injecting mocks or a canned LLM). */
  overrides?: Partial<Providers>;
}

export function createProviders({ mode, env, overrides = {} }: CreateProvidersOpts): Providers {
  if (mode === "mock") {
    return {
      llm: new MockLlm(),
      tts: new MockTts(),
      asr: new MockAsr(),
      image: new MockImage(),
      video: new MockVideo(),
      lipsync: new MockLipsync(),
      talking: new MockTalking(),
      ...overrides,
    };
  }
  for (const [capability, envVar] of Object.entries(LIVE_ENV) as [keyof Providers, string][]) {
    if (overrides[capability]) continue;
    if (!env[envVar]) throw new NotConfiguredError(capability, envVar);
  }
  const live: Partial<Providers> = { ...overrides, llm: overrides.llm ?? GeminiLlm.fromEnv(env) };
  // Keys are present but no live adapter exists yet; still refuse rather than silently using a mock.
  const missing = (Object.keys(LIVE_ENV) as (keyof Providers)[]).find((c) => !live[c]);
  if (missing) throw new NotConfiguredError(missing, `a live ${missing} adapter (not implemented yet)`);
  return live as Providers;
}
