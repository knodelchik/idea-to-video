/**
 * Live video: ByteDance Seedance 2.0 image-to-video with native, lip-synced speech (the line is in the prompt,
 * in double quotes). Three transports, chosen by SEEDANCE_TRANSPORT (default fal), priced differently for the same model:
 *
 * - `fal` (VERIFIED against https://fal.ai/models/bytedance/seedance-2.0/image-to-video/llms.txt, 2026-10-16):
 *   endpoint `bytedance/seedance-2.0/image-to-video` (or `.../fast/image-to-video`); input `prompt`, `image_url`,
 *   `duration` (a STRING "4".."15"), `aspect_ratio` "9:16", `resolution` "720p", `generate_audio` true; output
 *   `video.url`. There is no `seed` input, so a retry relies on sampling variety. Policy blocks are 422s with
 *   `detail[].type === "content_policy_violation"` (https://fal.ai/docs/model-apis/errors).
 * - `byteplus` (VERIFIED request/response shape against the official BytePlus Python SDK
 *   byteplus-python-sdk-v2 3.0.62, `byteplussdkarkruntime/resources/content_generation/tasks.py`, and prices/model ids
 *   against https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106, 2026-10-16): POST
 *   `{base}/contents/generations/tasks` with `model`, `content[]` (text + `image_url: { url }` with
 *   `role: "first_frame"`), top-level `ratio`, `duration` (int), `resolution`, `generate_audio`, `watermark`; then
 *   GET `{base}/contents/generations/tasks/{id}` until `status` is `succeeded` (→ `content.video_url`,
 *   `usage.completion_tokens`) or `failed`/`cancelled`/`expired`. Inline base64 data URLs for the image are documented
 *   only by third-party gateways (UNVERIFIED on BytePlus itself). The real-face rejection text seen in the wild is
 *   "the input image may contain a real person".
 * - `openrouter` (VERIFIED 2026-10-18 against https://openrouter.ai/docs/guides/overview/multimodal/video-generation,
 *   https://openrouter.ai/docs/cookbook/video-generation/image-to-video, the OpenAPI page
 *   https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request,
 *   https://openrouter.ai/bytedance/seedance-2.0/llms.txt and GET https://openrouter.ai/api/v1/videos/models):
 *   POST `{base}/videos` { model, prompt, duration (int 4..15), resolution, aspect_ratio, generate_audio,
 *   frame_images: [{ type: "image_url", image_url: { url }, frame_type: "first_frame" }] (https or base64 data URL),
 *   input_references?, seed? } → 202 { id, polling_url, status }; GET `{base}/videos/{id}` until `completed`
 *   (usage.cost = USD) or `failed`/`cancelled`/`expired` (`error` is a string); bytes from GET
 *   `{base}/videos/{id}/content` WITH the Authorization header. Billed $7/M video tokens (standard) and $4.2/M (fast).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { probe as ffprobe } from "../media/ffmpeg.ts";
import { NotConfiguredError, PolicyRejectedError } from "./errors.ts";
import { falClient, falUpload, falVideoUrl, rethrowFalPolicy, type FalLike } from "./fal.ts";
import { dataUrl, download, HttpError, type FetchLike } from "./http.ts";
import type { AnimateRequest, AnimateResult, VideoCapabilities, VideoProvider } from "./types.ts";

type Env = Record<string, string | undefined>;
/** Measures a downloaded file. Injected in tests (fake bytes are not a real mp4); ffprobe otherwise. */
export type Probe = (path: string) => Promise<{ seconds: number; hasAudio: boolean }>;

/** Integer clip lengths Seedance 2.0 accepts (both transports). */
export const SEEDANCE_DURATIONS = Array.from({ length: 12 }, (_, i) => i + 4);
export const SEEDANCE_RESOLUTION = "720p";
export const SEEDANCE_RATIO = "9:16";

export const FAL_SEEDANCE_ENDPOINTS = {
  standard: "bytedance/seedance-2.0/image-to-video",
  fast: "bytedance/seedance-2.0/fast/image-to-video",
} as const;
/** fal list price at 720p, audio included (fal llms.txt pages above, verified). */
export const FAL_SEEDANCE_USD_PER_SECOND = { standard: 0.3034, fast: 0.2419 } as const;

export const BYTEPLUS_ARK_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
/** Model ids from the BytePlus pricing page (2026-10-16); override with SEEDANCE_MODEL. */
export const BYTEPLUS_SEEDANCE_MODELS = {
  standard: "dreamina-seedance-2-0-260128",
  fast: "dreamina-seedance-2-0-fast-260128",
} as const;
export const DEFAULT_BYTEPLUS_SEEDANCE_MODEL = BYTEPLUS_SEEDANCE_MODELS.standard;
/** USD per 1M output tokens, 480p/720p, no video input (BytePlus pricing page, 2026-10-16). */
export const BYTEPLUS_SEEDANCE_USD_PER_MTOK = { standard: 7.0, fast: 5.6 } as const;
/** Billing tokens per second: width × height × 24 fps / 1024 (pricing page formula), 720p 9:16 = 720×1280. */
export const BYTEPLUS_TOKENS_PER_SECOND_720P = (720 * 1280 * 24) / 1024;
/** List price per second at 720p: standard $0.1512, fast $0.12096. */
export const BYTEPLUS_SEEDANCE_USD_PER_SECOND = {
  standard: (BYTEPLUS_TOKENS_PER_SECOND_720P * BYTEPLUS_SEEDANCE_USD_PER_MTOK.standard) / 1e6,
  fast: (BYTEPLUS_TOKENS_PER_SECOND_720P * BYTEPLUS_SEEDANCE_USD_PER_MTOK.fast) / 1e6,
} as const;

/** One generation: image + prompt → a hosted video URL. */
export interface SeedanceJob {
  image: string;
  prompt: string;
  seconds: number;
  /** Identity/style references. Only the OpenRouter transport sends them (as `input_references`). */
  refs?: string[];
  /** Take number → `seed`, where the transport accepts one (OpenRouter). */
  seed?: number;
}
export interface SeedanceTransport {
  readonly name: string;
  /** List price per requested second, for the pre-call budget check. Absent → the dearest known rate. */
  readonly usdPerSecond?: number;
  /** `headers` are sent with the download (OpenRouter's content URL is not pre-signed). */
  run(job: SeedanceJob): Promise<{ url: string; costUsd: number; headers?: Record<string, string> }>;
}

// --- fal ---

export class FalSeedance implements SeedanceTransport {
  readonly name: string;
  constructor(private readonly opts: { fal: FalLike; tier?: keyof typeof FAL_SEEDANCE_ENDPOINTS }) {
    this.name = `fal-seedance-2.0${opts.tier === "fast" ? "-fast" : ""}`;
  }
  get usdPerSecond(): number {
    return FAL_SEEDANCE_USD_PER_SECOND[this.opts.tier ?? "standard"];
  }
  get endpoint(): string {
    return FAL_SEEDANCE_ENDPOINTS[this.opts.tier ?? "standard"];
  }

  input(job: SeedanceJob, imageUrl: string): Record<string, unknown> {
    return {
      prompt: job.prompt,
      image_url: imageUrl,
      duration: String(job.seconds),
      aspect_ratio: SEEDANCE_RATIO,
      resolution: SEEDANCE_RESOLUTION,
      generate_audio: true,
    };
  }

  async run(job: SeedanceJob) {
    const input = this.input(job, await falUpload(this.opts.fal, job.image));
    const { data } = await this.opts.fal.subscribe(this.endpoint, { input }).catch((e: unknown) => rethrowFalPolicy(this.name, e));
    return { url: falVideoUrl(this.endpoint, data), costUsd: job.seconds * FAL_SEEDANCE_USD_PER_SECOND[this.opts.tier ?? "standard"] };
  }
}

// --- BytePlus ModelArk ---

const TaskCreated = z.object({ id: z.string() });
const TaskStatus = z.object({
  status: z.string(),
  content: z.object({ video_url: z.string() }).partial().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullish(),
  usage: z.object({ completion_tokens: z.number() }).partial().nullish(),
});

/** Real-face filter / moderation wording (UNVERIFIED codes; the "real person" text is the one seen in the wild). */
export const isPolicyText = (s: string): boolean => /sensitive|real person|content policy|risk control/i.test(s);

export class BytePlusSeedance implements SeedanceTransport {
  readonly name: string;
  constructor(
    private readonly opts: {
      apiKey: string;
      tier?: keyof typeof BYTEPLUS_SEEDANCE_MODELS;
      model?: string;
      base?: string;
      fetch?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      pollMs?: number;
      timeoutMs?: number;
    },
  ) {
    this.name = `byteplus-seedance-2.0${opts.tier === "fast" ? "-fast" : ""}`;
  }

  private get tier(): keyof typeof BYTEPLUS_SEEDANCE_MODELS {
    return this.opts.tier ?? "standard";
  }
  get usdPerSecond(): number {
    return BYTEPLUS_SEEDANCE_USD_PER_SECOND[this.tier];
  }
  get base(): string {
    return this.opts.base ?? BYTEPLUS_ARK_BASE;
  }
  private get f(): FetchLike {
    return this.opts.fetch ?? (globalThis.fetch as FetchLike);
  }
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" };
  }

  body(job: SeedanceJob, image: string): Record<string, unknown> {
    return {
      model: this.opts.model ?? BYTEPLUS_SEEDANCE_MODELS[this.tier],
      content: [
        { type: "text", text: job.prompt },
        { type: "image_url", image_url: { url: image }, role: "first_frame" },
      ],
      ratio: SEEDANCE_RATIO,
      duration: job.seconds,
      resolution: SEEDANCE_RESOLUTION,
      generate_audio: true,
      watermark: false,
    };
  }

  /** 4xx whose body reads like moderation → PolicyRejectedError; other failures → HttpError as usual. */
  private async check(res: Response): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500 && isPolicyText(text)) throw new PolicyRejectedError(this.name, text.slice(0, 300));
    throw new HttpError(this.name, res.status, text);
  }

  async run(job: SeedanceJob) {
    const created = await this.check(
      await this.f(`${this.base}/contents/generations/tasks`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(job, await dataUrl(job.image))),
      }),
    );
    const { id } = TaskCreated.parse(await created.json());
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.opts.pollMs ?? 5000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const res = await this.check(
        await this.f(`${this.base}/contents/generations/tasks/${encodeURIComponent(id)}`, { method: "GET", headers: this.headers() }),
      );
      const t = TaskStatus.parse(await res.json());
      if (t.status === "succeeded") {
        if (!t.content?.video_url) throw new Error(`${this.name}: task ${id} succeeded without content.video_url`);
        // Billed on tokens; the reply's own count beats our size estimate when present.
        const tokens = t.usage?.completion_tokens;
        const costUsd = tokens ? (tokens * BYTEPLUS_SEEDANCE_USD_PER_MTOK[this.tier]) / 1e6 : job.seconds * this.usdPerSecond;
        return { url: t.content.video_url, costUsd };
      }
      if (t.status === "failed" || t.status === "cancelled" || t.status === "expired") {
        const why = [t.error?.code, t.error?.message].filter(Boolean).join(": ") || t.status;
        if (isPolicyText(why)) throw new PolicyRejectedError(this.name, why);
        throw new Error(`${this.name}: task ${id} ${t.status}: ${why}`);
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: task ${id} still ${t.status} after timeout`);
      await sleep(pollMs);
    }
  }
}

// --- OpenRouter ---

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** Model ids from GET https://openrouter.ai/api/v1/videos/models (2026-10-18); override with OPENROUTER_VIDEO_MODEL. */
export const OPENROUTER_SEEDANCE_MODELS = {
  standard: "bytedance/seedance-2.0",
  fast: "bytedance/seedance-2.0-fast",
} as const;
/** USD per video token, `pricing_skus.video_tokens` (same with or without audio) from the same endpoint. */
export const OPENROUTER_SEEDANCE_USD_PER_TOKEN = { standard: 7e-6, fast: 4.2e-6 } as const;
/** 9:16 pixel sizes the models list in `supported_sizes`. */
export const SEEDANCE_SIZES_9x16 = { "480p": [480, 854], "720p": [720, 1280] } as const;
/**
 * Video tokens for a clip: width × height × 24 fps / 1024 × seconds. The formula is BytePlus's (pricing page); OpenRouter
 * only publishes the per-token price, so this is the estimate used when a job reports no `usage.cost`.
 */
export const seedanceTokens = (width: number, height: number, seconds: number): number => ((width * height * 24) / 1024) * seconds;

const VideoJob = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().nullish(),
  usage: z.object({ cost: z.number().nullish() }).partial().nullish(),
});

export class OpenRouterSeedance implements SeedanceTransport {
  readonly name: string;
  constructor(
    private readonly opts: {
      apiKey: string;
      tier?: keyof typeof OPENROUTER_SEEDANCE_MODELS;
      model?: string;
      base?: string;
      fetch?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      pollMs?: number;
      timeoutMs?: number;
    },
  ) {
    this.name = `openrouter-seedance-2.0${opts.tier === "fast" ? "-fast" : ""}`;
  }

  private get tier(): keyof typeof OPENROUTER_SEEDANCE_MODELS {
    return this.opts.tier ?? "standard";
  }
  get model(): string {
    return this.opts.model ?? OPENROUTER_SEEDANCE_MODELS[this.tier];
  }
  get usdPerSecond(): number {
    const [w, h] = SEEDANCE_SIZES_9x16[SEEDANCE_RESOLUTION];
    return seedanceTokens(w, h, 1) * OPENROUTER_SEEDANCE_USD_PER_TOKEN[this.tier];
  }
  get base(): string {
    return this.opts.base ?? OPENROUTER_BASE;
  }
  private get f(): FetchLike {
    return this.opts.fetch ?? (globalThis.fetch as FetchLike);
  }
  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}` };
  }

  async body(job: SeedanceJob): Promise<Record<string, unknown>> {
    const refs = job.refs ?? [];
    return {
      model: this.model,
      prompt: job.prompt,
      duration: job.seconds,
      resolution: SEEDANCE_RESOLUTION,
      aspect_ratio: SEEDANCE_RATIO,
      generate_audio: true,
      frame_images: [{ type: "image_url", image_url: { url: await dataUrl(job.image) }, frame_type: "first_frame" }],
      // Docs: with frame_images present the job is image-to-video, so references may be ignored by the provider.
      ...(refs.length
        ? { input_references: await Promise.all(refs.map(async (r) => ({ type: "image_url", image_url: { url: await dataUrl(r) } }))) }
        : {}),
      ...(job.seed !== undefined ? { seed: job.seed } : {}),
      // `watermark` is in the model's allowed_passthrough_parameters; provider slug "seed" from
      // /api/v1/models/bytedance/seedance-2.0/endpoints. Flat shape UNVERIFIED (unknown keys are dropped, per the docs).
      provider: { options: { seed: { watermark: false } } },
    };
  }

  /** 4xx whose body reads like moderation → PolicyRejectedError; other failures → HttpError. */
  private async check(res: Response): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500 && isPolicyText(text)) throw new PolicyRejectedError(this.name, text.slice(0, 300));
    throw new HttpError(this.name, res.status, text);
  }

  async run(job: SeedanceJob) {
    const created = await this.check(
      await this.f(`${this.base}/videos`, {
        method: "POST",
        headers: { ...this.auth(), "Content-Type": "application/json" },
        body: JSON.stringify(await this.body(job)),
      }),
    );
    const { id } = VideoJob.pick({ id: true }).parse(await created.json());
    const jobUrl = `${this.base}/videos/${encodeURIComponent(id)}`;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.opts.pollMs ?? 10_000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 20 * 60_000);
    for (;;) {
      await sleep(pollMs); // a job is never done at submit time; the docs poll after a wait too
      const t = VideoJob.parse(await (await this.check(await this.f(jobUrl, { method: "GET", headers: this.auth() }))).json());
      if (t.status === "completed") {
        const [w, h] = SEEDANCE_SIZES_9x16[SEEDANCE_RESOLUTION];
        const estimate = seedanceTokens(w, h, job.seconds) * OPENROUTER_SEEDANCE_USD_PER_TOKEN[this.tier];
        // usage.cost is what OpenRouter charged; the token estimate is only for a reply without it.
        const costUsd = typeof t.usage?.cost === "number" ? t.usage.cost : estimate;
        return { url: `${jobUrl}/content`, costUsd, headers: this.auth() };
      }
      if (t.status === "failed" || t.status === "cancelled" || t.status === "expired") {
        const why = t.error || t.status;
        if (isPolicyText(why)) throw new PolicyRejectedError(this.name, why);
        throw new Error(`${this.name}: job ${id} ${t.status}: ${why}`);
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: job ${id} still ${t.status} after timeout`);
    }
  }
}

// --- provider ---

export class SeedanceVideo implements VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities = { nativeSpeech: true, durations: SEEDANCE_DURATIONS };
  constructor(private readonly opts: { transport: SeedanceTransport; fetch?: FetchLike; probe?: Probe }) {
    this.name = opts.transport.name;
  }

  estimateUsd(req: AnimateRequest): number {
    return req.seconds * (this.opts.transport.usdPerSecond ?? FAL_SEEDANCE_USD_PER_SECOND.standard);
  }

  async animate(req: AnimateRequest): Promise<AnimateResult> {
    if (!SEEDANCE_DURATIONS.includes(req.seconds)) {
      throw new RangeError(`${this.name}: ${req.seconds} s is not one of ${SEEDANCE_DURATIONS.join(", ")}`);
    }
    await readFile(req.image); // a missing keyframe is our bug: fail before paying for an upload
    const { url, costUsd, headers } = await this.opts.transport.run({
      image: req.image,
      prompt: req.prompt,
      seconds: req.seconds,
      ...(req.refs?.length ? { refs: req.refs } : {}),
      ...(req.variant !== undefined ? { seed: req.variant } : {}),
    });
    await download(this.name, url, req.out, this.opts.fetch ?? (globalThis.fetch as FetchLike), headers);
    // Report what came back, not what we asked for (hard rule 4): `generate_audio: true` is a request, not a
    // guarantee, and the returned length can differ from `duration`. Cost is billed on the requested length.
    const { seconds, hasAudio } = await (this.opts.probe ?? ffprobe)(req.out);
    return { path: req.out, seconds, hasAudio, costUsd };
  }
}

export function seedanceFromEnv(env: Env, deps: { fal?: FalLike; fetch?: FetchLike; probe?: Probe } = {}): SeedanceVideo {
  const transport = (env.SEEDANCE_TRANSPORT || "fal").toLowerCase();
  const fetchDep = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.probe ? { probe: deps.probe } : {}) };
  const tier = env.SEEDANCE_TIER === "fast" ? "fast" : "standard";
  if (transport === "fal") {
    if (!env.FAL_KEY && !deps.fal) throw new NotConfiguredError("video", "FAL_KEY");
    return new SeedanceVideo({ transport: new FalSeedance({ fal: deps.fal ?? falClient(env.FAL_KEY!), tier }), ...fetchDep });
  }
  if (transport === "byteplus") {
    if (!env.ARK_API_KEY) throw new NotConfiguredError("video", "ARK_API_KEY");
    const t = new BytePlusSeedance({
      apiKey: env.ARK_API_KEY,
      tier,
      ...(env.SEEDANCE_MODEL ? { model: env.SEEDANCE_MODEL } : {}),
      ...(env.ARK_BASE_URL ? { base: env.ARK_BASE_URL } : {}),
      ...fetchDep,
    });
    return new SeedanceVideo({ transport: t, ...fetchDep });
  }
  if (transport === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new NotConfiguredError("video", "OPENROUTER_API_KEY");
    const t = new OpenRouterSeedance({
      apiKey: env.OPENROUTER_API_KEY,
      tier,
      ...(env.OPENROUTER_VIDEO_MODEL ? { model: env.OPENROUTER_VIDEO_MODEL } : {}),
      ...fetchDep,
    });
    return new SeedanceVideo({ transport: t, ...fetchDep });
  }
  throw new Error(`SEEDANCE_TRANSPORT: unknown "${transport}"; known: fal, byteplus, openrouter`);
}
