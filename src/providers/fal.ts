/**
 * The slice of `@fal-ai/client` our adapters use, behind an interface so tests inject a fake and never touch
 * the network. Docs: https://docs.fal.ai/model-apis/client , https://docs.fal.ai/model-apis/errors
 */
import { readFile } from "node:fs/promises";
import { ApiError, createFalClient } from "@fal-ai/client";
import { PolicyRejectedError } from "./errors.ts";
import { sniffMime } from "./http.ts";

export interface FalLike {
  subscribe(endpoint: string, opts: { input: Record<string, unknown>; logs?: boolean }): Promise<{ data: unknown; requestId: string }>;
  storage: { upload(file: Blob): Promise<string> };
}

export function falClient(apiKey: string): FalLike {
  const c = createFalClient({ credentials: apiKey });
  return {
    subscribe: (endpoint, opts) => c.subscribe(endpoint, opts) as Promise<{ data: unknown; requestId: string }>,
    storage: { upload: (file) => c.storage.upload(file) },
  };
}

/** Local file → fal CDN URL (fal model inputs take URLs). */
export async function falUpload(fal: FalLike, path: string): Promise<string> {
  const b = await readFile(path);
  return fal.storage.upload(new Blob([b], { type: sniffMime(b) }));
}

/**
 * fal reports policy blocks as a 422 whose `detail[]` items have `type: "content_policy_violation"`
 * (docs.fal.ai/model-apis/errors). Anything else is rethrown unchanged.
 */
export function rethrowFalPolicy(provider: string, e: unknown): never {
  if (e instanceof ApiError || (e && typeof e === "object" && "body" in e)) {
    const detail = (e as { body?: { detail?: unknown } }).body?.detail;
    const items = Array.isArray(detail) ? (detail as { type?: unknown; msg?: unknown }[]) : [];
    const hit = items.find((d) => d?.type === "content_policy_violation");
    if (hit) throw new PolicyRejectedError(provider, String(hit.msg ?? "content_policy_violation"));
  }
  throw e;
}

/** `{ video: { url } }` / `{ images: [{ url }] }` out of a fal result, or a clear error naming the endpoint. */
export function falVideoUrl(endpoint: string, data: unknown): string {
  const url = (data as { video?: { url?: unknown } } | undefined)?.video?.url;
  if (typeof url !== "string") throw new Error(`${endpoint}: result has no video.url: ${JSON.stringify(data).slice(0, 200)}`);
  return url;
}
export function falImageUrl(endpoint: string, data: unknown): string {
  const url = (data as { images?: { url?: unknown }[] } | undefined)?.images?.[0]?.url;
  if (typeof url !== "string") throw new Error(`${endpoint}: result has no images[0].url: ${JSON.stringify(data).slice(0, 200)}`);
  return url;
}
