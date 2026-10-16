/**
 * Shared bits for fetch-based live adapters. `fetch` is always injected so tests assert the exact request
 * with a fake and never touch the network.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider}: HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** 429 / 5xx mean "busy or broken right now": worth trying the next provider. 4xx otherwise is our bug. */
export const isTransient = (e: unknown): boolean =>
  e instanceof HttpError ? e.status === 429 || e.status >= 500 : e instanceof TypeError; // fetch network failure

export async function ensureOk(provider: string, res: Response): Promise<Response> {
  if (!res.ok) throw new HttpError(provider, res.status, await res.text().catch(() => ""));
  return res;
}

/** JSON object from an env var (e.g. a voice table override). Bad JSON fails loudly, naming the var. */
export function envJson(env: Record<string, string | undefined>, name: string): Record<string, string> {
  const raw = env[name];
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, string>;
  } catch {
    // fall through
  }
  throw new Error(`${name} must be a JSON object like {"female-adult":"<voice>"}`);
}

// --- WAV ---

const isRiff = (b: Uint8Array): boolean =>
  b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WAVE";

/** Wrap raw 16-bit little-endian PCM in a 44-byte RIFF header. Already-RIFF input is returned unchanged. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Buffer {
  if (isRiff(pcm)) return Buffer.from(pcm);
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Duration of a PCM WAV from its fmt/data chunks (walks chunks, so LIST/fact chunks are fine). */
export function wavSeconds(wav: Uint8Array): number {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (!isRiff(b)) throw new Error("not a RIFF/WAVE file");
  let byteRate = 0;
  for (let off = 12; off + 8 <= b.length; ) {
    const id = b.toString("ascii", off, off + 4);
    let size = b.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = b.readUInt32LE(off + 16);
    if (id === "data") {
      // Streaming encoders write 0 or 0xFFFFFFFF as a placeholder size: use what is actually there.
      if (size === 0 || off + 8 + size > b.length) size = b.length - off - 8;
      if (!byteRate) throw new Error("WAV data chunk before fmt chunk");
      return size / byteRate;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
