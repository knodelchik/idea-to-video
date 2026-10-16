/**
 * Live video: ByteDance Seedance 2.0 image-to-video with native, lip-synced speech (the line is in the prompt,
 * in double quotes). Two transports, chosen by SEEDANCE_TRANSPORT, because we don't yet know which key we get:
 *
 * - `fal` (VERIFIED against https://fal.ai/models/bytedance/seedance-2.0/image-to-video/llms.txt, 2026-10-16):
 *   endpoint `bytedance/seedance-2.0/image-to-video` (or `.../fast/image-to-video`); input `prompt`, `image_url`,
 *   `duration` (a STRING "4".."15"), `aspect_ratio` "9:16", `resolution` "720p", `generate_audio` true; output
 *   `video.url`. There is no `seed` input, so a retry relies on sampling variety. Policy blocks are 422s with
 *   `detail[].type === "content_policy_violation"` (https://fal.ai/docs/model-apis/errors).
 * - `byteplus` (UNVERIFIED: docs.byteplus.com renders client-side and could not be read; shape taken from
 *   https://www.datacamp.com/tutorial/seedance-2-0-api-guide): POST `{base}/contents/generations/tasks` with
 *   `model`, `content[]` (text + `image_url` with `role: "first_frame"`), top-level `ratio`, `duration` (int),
 *   `resolution`, `generate_audio`, `watermark`; then GET `{base}/contents/generations/tasks/{id}` until
 *   `status` is `succeeded` (→ `content.video_url`) or `failed`. Inline base64 data URLs for the image are an
 *   assumption. The only real-face rejection text seen is "the input image may contain a real person".
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
/** UNVERIFIED model id (third-party tutorial); override with SEEDANCE_MODEL. */
export const DEFAULT_BYTEPLUS_SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";
/** BytePlus 720p per second (docs/research/video-models.md; token-billed, so this is an estimate). */
export const BYTEPLUS_SEEDANCE_USD_PER_SECOND = 0.15;

/** One generation: image + prompt → a hosted video URL. */
export interface SeedanceJob {
  image: string;
  prompt: string;
  seconds: number;
}
export interface SeedanceTransport {
  readonly name: string;
  run(job: SeedanceJob): Promise<{ url: string; costUsd: number }>;
}

// --- fal ---

export class FalSeedance implements SeedanceTransport {
  readonly name: string;
  constructor(private readonly opts: { fal: FalLike; tier?: keyof typeof FAL_SEEDANCE_ENDPOINTS }) {
    this.name = `fal-seedance-2.0${opts.tier === "fast" ? "-fast" : ""}`;
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
});

/** Real-face filter / moderation wording (UNVERIFIED codes; the "real person" text is the one seen in the wild). */
export const isPolicyText = (s: string): boolean => /sensitive|real person|content policy|risk control/i.test(s);

export class BytePlusSeedance implements SeedanceTransport {
  readonly name = "byteplus-seedance-2.0";
  constructor(
    private readonly opts: {
      apiKey: string;
      model?: string;
      base?: string;
      fetch?: FetchLike;
      sleep?: (ms: number) => Promise<void>;
      pollMs?: number;
      timeoutMs?: number;
    },
  ) {}

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
      model: this.opts.model ?? DEFAULT_BYTEPLUS_SEEDANCE_MODEL,
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
        return { url: t.content.video_url, costUsd: job.seconds * BYTEPLUS_SEEDANCE_USD_PER_SECOND };
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

// --- provider ---

export class SeedanceVideo implements VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities = { nativeSpeech: true, durations: SEEDANCE_DURATIONS };
  constructor(private readonly opts: { transport: SeedanceTransport; fetch?: FetchLike; probe?: Probe }) {
    this.name = opts.transport.name;
  }

  async animate(req: AnimateRequest): Promise<AnimateResult> {
    if (!SEEDANCE_DURATIONS.includes(req.seconds)) {
      throw new RangeError(`${this.name}: ${req.seconds} s is not one of ${SEEDANCE_DURATIONS.join(", ")}`);
    }
    await readFile(req.image); // a missing keyframe is our bug: fail before paying for an upload
    const { url, costUsd } = await this.opts.transport.run({ image: req.image, prompt: req.prompt, seconds: req.seconds });
    await download(this.name, url, req.out, this.opts.fetch ?? (globalThis.fetch as FetchLike));
    // Report what came back, not what we asked for (hard rule 4): `generate_audio: true` is a request, not a
    // guarantee, and the returned length can differ from `duration`. Cost is billed on the requested length.
    const { seconds, hasAudio } = await (this.opts.probe ?? ffprobe)(req.out);
    return { path: req.out, seconds, hasAudio, costUsd };
  }
}

export function seedanceFromEnv(env: Env, deps: { fal?: FalLike; fetch?: FetchLike; probe?: Probe } = {}): SeedanceVideo {
  const transport = (env.SEEDANCE_TRANSPORT || "fal").toLowerCase();
  const fetchDep = { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.probe ? { probe: deps.probe } : {}) };
  if (transport === "fal") {
    if (!env.FAL_KEY && !deps.fal) throw new NotConfiguredError("video", "FAL_KEY");
    const tier = env.SEEDANCE_TIER === "fast" ? "fast" : "standard";
    return new SeedanceVideo({ transport: new FalSeedance({ fal: deps.fal ?? falClient(env.FAL_KEY!), tier }), ...fetchDep });
  }
  if (transport === "byteplus") {
    if (!env.ARK_API_KEY) throw new NotConfiguredError("video", "ARK_API_KEY");
    const t = new BytePlusSeedance({
      apiKey: env.ARK_API_KEY,
      model: env.SEEDANCE_MODEL || DEFAULT_BYTEPLUS_SEEDANCE_MODEL,
      ...(env.ARK_BASE_URL ? { base: env.ARK_BASE_URL } : {}),
      ...fetchDep,
    });
    return new SeedanceVideo({ transport: t, ...fetchDep });
  }
  throw new Error(`SEEDANCE_TRANSPORT: unknown "${transport}"; known: fal, byteplus`);
}
