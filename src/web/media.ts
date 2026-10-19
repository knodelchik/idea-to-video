/** Static file and video serving with single-range support (a <video> seeks with `Range: bytes=…`). */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Range = { start: number; end: number };

/** One `bytes=` range → inclusive offsets; null = no (usable) range header, serve the whole file. */
export function parseRange(header: string | undefined, size: number): Range | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Serves a file the caller already resolved and checked; 404 when it isn't a file. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, cache = "private, max-age=3600"): Promise<void> {
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const range = parseRange(req.headers.range, size);
  const head = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache };
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...head, "content-range": `bytes */${size}` }).end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...head,
    "content-length": String(length),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
