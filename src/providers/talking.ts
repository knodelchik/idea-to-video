/**
 * Live talking (audio-driven avatar): image + verified speech → talking clip. Kling AI Avatar v2 on fal.
 * VERIFIED against https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard/llms.txt and
 * .../v2/pro/llms.txt (2026-10-16): input `image_url`, `audio_url` (required), `prompt` (optional);
 * output `video.url` and `duration` (seconds). $0.0562/s standard, $0.115/s pro, billed on output seconds.
 */
import { probe as ffprobe } from "../media/ffmpeg.ts";
import { NotConfiguredError } from "./errors.ts";
import { falClient, falUpload, falVideoUrl, rethrowFalPolicy, type FalLike } from "./fal.ts";
import { download, type FetchLike } from "./http.ts";
import type { TalkingProvider } from "./types.ts";

type Env = Record<string, string | undefined>;
type Probe = (path: string) => Promise<{ seconds: number }>;

export const KLING_AVATAR_ENDPOINTS = {
  standard: "fal-ai/kling-video/ai-avatar/v2/standard",
  pro: "fal-ai/kling-video/ai-avatar/v2/pro",
} as const;
export type KlingAvatarTier = keyof typeof KLING_AVATAR_ENDPOINTS;
export const KLING_AVATAR_USD_PER_SECOND: Record<KlingAvatarTier, number> = { standard: 0.0562, pro: 0.115 };
/**
 * The budget estimate is synchronous and can't probe the audio, so it assumes a clip this long (one shot's line
 * rarely runs past it). The bench plans with the real audio length instead.
 */
export const KLING_AVATAR_ESTIMATE_SECONDS = 10;

export class FalKlingAvatar implements TalkingProvider {
  readonly name: string;
  constructor(private readonly deps: { fal: FalLike; tier?: KlingAvatarTier; fetch?: FetchLike; probe?: Probe }) {
    this.name = `fal-kling-avatar-v2-${this.tier}`;
  }
  get tier(): KlingAvatarTier {
    return this.deps.tier ?? "standard";
  }
  get endpoint(): string {
    return KLING_AVATAR_ENDPOINTS[this.tier];
  }
  estimateUsd(): number {
    return KLING_AVATAR_ESTIMATE_SECONDS * KLING_AVATAR_USD_PER_SECOND[this.tier];
  }

  async talk({ image, audio, prompt, out }: { image: string; audio: string; prompt: string; out: string }) {
    const { fal } = this.deps;
    const input = { image_url: await falUpload(fal, image), audio_url: await falUpload(fal, audio), prompt };
    const { data } = await fal.subscribe(this.endpoint, { input }).catch((e: unknown) => rethrowFalPolicy(this.name, e));
    await download(this.name, falVideoUrl(this.endpoint, data), out, this.deps.fetch ?? (globalThis.fetch as FetchLike));
    // Billed on output length: use the file's measured length, not the reply's claim (hard rule 4).
    const { seconds } = await (this.deps.probe ?? ffprobe)(out);
    return { path: out, costUsd: seconds * KLING_AVATAR_USD_PER_SECOND[this.tier] };
  }
}

export function klingAvatarFromEnv(
  env: Env,
  tier: KlingAvatarTier = "standard",
  deps: { fal?: FalLike; fetch?: FetchLike; probe?: Probe } = {},
): FalKlingAvatar {
  if (!env.FAL_KEY && !deps.fal) throw new NotConfiguredError("talking", "FAL_KEY");
  return new FalKlingAvatar({
    fal: deps.fal ?? falClient(env.FAL_KEY!),
    tier,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
}
