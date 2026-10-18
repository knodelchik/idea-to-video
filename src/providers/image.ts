/**
 * Live portrait / keyframe images, always 9:16, with reference images for identity. IMAGE_PROVIDER selects:
 *
 * - `fal-nano-banana` (VERIFIED, https://fal.ai/models/fal-ai/nano-banana/edit/llms.txt): with refs →
 *   `fal-ai/nano-banana/edit` { prompt, image_urls[], aspect_ratio "9:16", num_images 1, output_format "png" };
 *   without refs → `fal-ai/nano-banana` with the same fields minus image_urls (inferred from the edit page);
 *   output `images[0].url`; $0.039 / image.
 * - `gemini` (VERIFIED request shape, https://ai.google.dev/gemini-api/docs/image-generation; Interactions API):
 *   POST /v1beta/interactions { model, input: [{ type: "user_input", content: [text, image…] }],
 *   response_format: { type: "image", aspect_ratio: "9:16", image_size: "1K" } }; base64 image in the output.
 *   The exact output wrapper is parsed leniently (UNVERIFIED). $0.0336 / 1K image for gemini-nano-banana-2.1.
 * - `seedream` (request fields VERIFIED against the official BytePlus Python SDK 3.0.62 `images.generate`; model id
 *   and price against https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106, 2026-10-16):
 *   POST {ark}/images/generations { model, prompt, image[] (data URLs, UNVERIFIED), size, response_format "b64_json",
 *   watermark false } → data[0].b64_json. Key ARK_API_KEY (the same as Seedance on BytePlus). $0.035 / image.
 * - `openrouter` (VERIFIED 2026-10-18 against https://openrouter.ai/docs/guides/overview/multimodal/image-generation and
 *   GET https://openrouter.ai/api/v1/images/models[/<id>/endpoints]): the dedicated Image API, not chat completions.
 *   POST {base}/images { model, prompt, aspect_ratio "9:16", n 1, resolution?, input_references: [{ type: "image_url",
 *   image_url: { url } }] (https or base64 data URL), seed? } → { data: [{ b64_json, media_type }], usage: { cost } }.
 *   Key OPENROUTER_API_KEY. Default model google/gemini-nano-banana-2.1 at 1K (~$0.0336 / image).
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { NotConfiguredError } from "./errors.ts";
import { falClient, falImageUrl, falUpload, rethrowFalPolicy, type FalLike } from "./fal.ts";
import { dataUrl, download, ensureOk, sniffMime, type FetchLike } from "./http.ts";
import { BYTEPLUS_ARK_BASE, OPENROUTER_BASE } from "./seedance.ts";
import type { ImageProvider, ImageRequest } from "./types.ts";

type Env = Record<string, string | undefined>;
const fetchOf = (f?: FetchLike): FetchLike => f ?? (globalThis.fetch as FetchLike);

// --- fal nano-banana ---

export const FAL_NANO_BANANA = { text: "fal-ai/nano-banana", edit: "fal-ai/nano-banana/edit" } as const;
export const FAL_NANO_BANANA_USD = 0.039;

export class FalNanoBananaImage implements ImageProvider {
  readonly name = "fal-nano-banana";
  estimateUsd(): number {
    return FAL_NANO_BANANA_USD;
  }
  constructor(private readonly deps: { fal: FalLike; fetch?: FetchLike }) {}

  async generate({ prompt, refs = [], out, variant }: ImageRequest) {
    const { fal } = this.deps;
    const endpoint = refs.length ? FAL_NANO_BANANA.edit : FAL_NANO_BANANA.text;
    const input: Record<string, unknown> = {
      prompt,
      aspect_ratio: "9:16",
      num_images: 1,
      output_format: "png",
      ...(variant ? { seed: variant } : {}),
    };
    if (refs.length) input.image_urls = await Promise.all(refs.map((r) => falUpload(fal, r)));
    const { data } = await fal.subscribe(endpoint, { input }).catch((e: unknown) => rethrowFalPolicy(this.name, e));
    await download(this.name, falImageUrl(endpoint, data), out, fetchOf(this.deps.fetch));
    return { path: out, costUsd: FAL_NANO_BANANA_USD };
  }
}

// --- Gemini ---

export const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
export const GEMINI_IMAGE_USD = 0.0336;

const Part = z.object({ type: z.string(), data: z.string().optional() }).passthrough();
const GeminiImageResponse = z
  .object({
    steps: z.array(z.object({ type: z.string(), content: z.array(Part).optional() })).optional(),
    outputs: z.array(Part).optional(),
  })
  .passthrough();

export class GeminiImage implements ImageProvider {
  readonly name = "gemini-image";
  estimateUsd(): number {
    return GEMINI_IMAGE_USD;
  }
  constructor(private readonly opts: { apiKey: string; model?: string; fetch?: FetchLike }) {}

  async body({ prompt, refs = [] }: ImageRequest): Promise<unknown> {
    const images = await Promise.all(
      refs.map(async (r) => {
        const b = await readFile(r);
        return { type: "image", mime_type: sniffMime(b), data: b.toString("base64") };
      }),
    );
    return {
      model: this.opts.model ?? DEFAULT_GEMINI_IMAGE_MODEL,
      input: [{ type: "user_input", content: [{ type: "text", text: prompt }, ...images] }],
      response_format: { type: "image", aspect_ratio: "9:16", image_size: "1K" },
    };
  }

  async generate(req: ImageRequest) {
    const res = await ensureOk(
      this.name,
      await fetchOf(this.opts.fetch)(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(await this.body(req)),
      }),
    );
    const r = GeminiImageResponse.parse(await res.json());
    const parts = [...(r.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []), ...(r.outputs ?? [])];
    const data = parts.filter((p) => /image/.test(p.type) && p.data).at(-1)?.data;
    if (!data) throw new Error(`${this.name}: response has no image`);
    await writeFile(req.out, Buffer.from(data, "base64"));
    return { path: req.out, costUsd: GEMINI_IMAGE_USD };
  }
}

// --- Seedream (BytePlus) ---

/** "seedream-5-0-260128" (the old default) is not a model id; the pricing page lists "seedream-5-0-lite-260128". */
export const DEFAULT_SEEDREAM_MODEL = "seedream-5-0-lite-260128";
export const SEEDREAM_USD = 0.035;
/** 9:16 at about 3.7 MP (UNVERIFIED that Seedream accepts this exact size; override with SEEDREAM_SIZE). */
export const SEEDREAM_SIZE = "1440x2560";

const SeedreamResponse = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })).min(1) });

export class SeedreamImage implements ImageProvider {
  readonly name = "byteplus-seedream";
  estimateUsd(): number {
    return SEEDREAM_USD;
  }
  constructor(private readonly opts: { apiKey: string; model?: string; size?: string; base?: string; fetch?: FetchLike }) {}

  async body({ prompt, refs = [], variant }: ImageRequest): Promise<Record<string, unknown>> {
    return {
      model: this.opts.model ?? DEFAULT_SEEDREAM_MODEL,
      prompt,
      ...(refs.length ? { image: await Promise.all(refs.map(dataUrl)) } : {}),
      size: this.opts.size ?? SEEDREAM_SIZE,
      response_format: "b64_json",
      watermark: false,
      ...(variant ? { seed: variant } : {}),
    };
  }

  async generate(req: ImageRequest) {
    const f = fetchOf(this.opts.fetch);
    const res = await ensureOk(
      this.name,
      await f(`${this.opts.base ?? BYTEPLUS_ARK_BASE}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(await this.body(req)),
      }),
    );
    const first = SeedreamResponse.parse(await res.json()).data[0]!;
    if (first.b64_json) await writeFile(req.out, Buffer.from(first.b64_json, "base64"));
    else if (first.url) await download(this.name, first.url, req.out, f);
    else throw new Error(`${this.name}: response has neither b64_json nor url`);
    return { path: req.out, costUsd: SEEDREAM_USD };
  }
}

// --- OpenRouter ---

export const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-nano-banana-2.1";
/**
 * Per-model request knobs and list price, from GET /api/v1/images/models/<id>/endpoints (2026-10-18). A parameter an
 * endpoint doesn't list is unsupported, so `resolution` / `seed` are only sent where listed. Unknown models get neither.
 */
export const OPENROUTER_IMAGE_MODELS: Record<string, { resolution?: string; seed: boolean; usd: number }> = {
  // $30 / 1M output tokens; a 1K image is ~1120 tokens.
  "google/gemini-nano-banana-2.1": { resolution: "1K", seed: false, usd: 0.0336 },
  "bytedance-seed/seedream-5-0-flash": { resolution: "1K", seed: true, usd: 0.018 },
  "bytedance-seed/seedream-5-0-lite": { resolution: "2K", seed: true, usd: 0.035 },
};
/** Budget estimate for a model not in the table (the dearest above, rounded up). */
export const OPENROUTER_IMAGE_FALLBACK_USD = 0.04;

const OpenRouterImageResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().optional() })).min(1),
  usage: z.object({ cost: z.number().nullish() }).partial().nullish(),
});

export class OpenRouterImage implements ImageProvider {
  readonly name = "openrouter-image";
  constructor(private readonly opts: { apiKey: string; model?: string; base?: string; fetch?: FetchLike }) {}

  get model(): string {
    return this.opts.model ?? DEFAULT_OPENROUTER_IMAGE_MODEL;
  }
  estimateUsd(): number {
    return OPENROUTER_IMAGE_MODELS[this.model]?.usd ?? OPENROUTER_IMAGE_FALLBACK_USD;
  }

  async body({ prompt, refs = [], variant }: ImageRequest): Promise<Record<string, unknown>> {
    const caps = OPENROUTER_IMAGE_MODELS[this.model];
    return {
      model: this.model,
      prompt,
      aspect_ratio: "9:16",
      n: 1,
      ...(caps?.resolution ? { resolution: caps.resolution } : {}),
      ...(refs.length
        ? { input_references: await Promise.all(refs.map(async (r) => ({ type: "image_url", image_url: { url: await dataUrl(r) } }))) }
        : {}),
      ...(variant && caps?.seed ? { seed: variant } : {}),
    };
  }

  async generate(req: ImageRequest) {
    const res = await ensureOk(
      this.name,
      await fetchOf(this.opts.fetch)(`${this.opts.base ?? OPENROUTER_BASE}/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(await this.body(req)),
      }),
    );
    const r = OpenRouterImageResponse.parse(await res.json());
    const b64 = r.data[0]!.b64_json;
    if (!b64) throw new Error(`${this.name}: response has no b64_json`);
    await writeFile(req.out, Buffer.from(b64, "base64"));
    return { path: req.out, costUsd: typeof r.usage?.cost === "number" ? r.usage.cost : this.estimateUsd() };
  }
}

export function imageFromEnv(env: Env, deps: { fal?: FalLike; fetch?: FetchLike } = {}): ImageProvider {
  const which = (env.IMAGE_PROVIDER || "fal-nano-banana").toLowerCase();
  const fetchDep = deps.fetch ? { fetch: deps.fetch } : {};
  if (which === "fal-nano-banana") {
    if (!env.FAL_KEY && !deps.fal) throw new NotConfiguredError("image", "FAL_KEY");
    return new FalNanoBananaImage({ fal: deps.fal ?? falClient(env.FAL_KEY!), ...fetchDep });
  }
  if (which === "gemini") {
    if (!env.GEMINI_API_KEY) throw new NotConfiguredError("image", "GEMINI_API_KEY");
    return new GeminiImage({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL, ...fetchDep });
  }
  if (which === "seedream") {
    if (!env.ARK_API_KEY) throw new NotConfiguredError("image", "ARK_API_KEY");
    return new SeedreamImage({
      apiKey: env.ARK_API_KEY,
      model: env.SEEDREAM_MODEL || DEFAULT_SEEDREAM_MODEL,
      ...(env.SEEDREAM_SIZE ? { size: env.SEEDREAM_SIZE } : {}),
      ...(env.ARK_BASE_URL ? { base: env.ARK_BASE_URL } : {}),
      ...fetchDep,
    });
  }
  if (which === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new NotConfiguredError("image", "OPENROUTER_API_KEY");
    return new OpenRouterImage({
      apiKey: env.OPENROUTER_API_KEY,
      ...(env.OPENROUTER_IMAGE_MODEL ? { model: env.OPENROUTER_IMAGE_MODEL } : {}),
      ...fetchDep,
    });
  }
  throw new Error(`IMAGE_PROVIDER: unknown "${which}"; known: seedream, fal-nano-banana, gemini, openrouter`);
}
