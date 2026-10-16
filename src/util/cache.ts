/**
 * Content-addressed artifacts. Same inputs → same key → same path, so a resumed run finds finished work
 * instead of paying for it again (CLAUDE.md rule 5).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

/** A part that is hashed by the *contents* of the file at `file`, not by its path. */
export interface FilePart {
  file: string;
}
export type KeyPart = string | number | boolean | null | undefined | FilePart;

const isFile = (p: KeyPart): p is FilePart => typeof p === "object" && p !== null && "file" in p;

/**
 * sha256 over the parts, in order. Each part is tagged and length-delimited so ("ab","c") ≠ ("a","bc")
 * and a string equal to a file's bytes ≠ that file. Returns the first 16 hex chars (64 bits: plenty per run dir).
 */
export async function contentKey(...parts: KeyPart[]): Promise<string> {
  const h = createHash("sha256");
  for (const part of parts) {
    if (isFile(part)) {
      const size = (await stat(part.file)).size;
      h.update(`f:${size}:`);
      for await (const chunk of createReadStream(part.file)) h.update(chunk as Buffer);
    } else {
      const s = part === undefined ? "\u0000undefined" : JSON.stringify(part);
      h.update(`s:${Buffer.byteLength(s)}:${s}`);
    }
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

export interface OnceResult<T> {
  path: string;
  /** true when the file already existed and `fn` was not called. */
  cached: boolean;
  /** What `fn` returned (only when it ran). */
  result?: T;
}

const inflight = new Map<string, Promise<OnceResult<unknown>>>();

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns `out` if it exists; otherwise runs `fn(tmp)` and atomically renames tmp → out.
 * - tmp keeps the extension of `out` (ffmpeg picks the container from it).
 * - Companion files `fn` writes next to tmp (e.g. `<tmp>.transcript.json`) are moved to `<out>.<suffix>`
 *   *before* the main file, so an existing `out` always has its sidecars.
 * - If `fn` throws, tmp and its companions are deleted: a crash never leaves a partial `out`.
 * - Concurrent calls for the same `out` in this process share one `fn` call.
 */
export function once<T>(out: string, fn: (tmp: string) => Promise<T>): Promise<OnceResult<T>> {
  const running = inflight.get(out);
  if (running) return running.then((r) => ({ ...r, cached: true, result: undefined })) as Promise<OnceResult<T>>;
  const p = doOnce(out, fn).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

async function doOnce<T>(out: string, fn: (tmp: string) => Promise<T>): Promise<OnceResult<T>> {
  if (await exists(out)) return { path: out, cached: true };
  const dir = dirname(out);
  await mkdir(dir, { recursive: true });
  const ext = extname(out);
  const tmpName = `${basename(out, ext)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}${ext}`;
  const tmp = join(dir, tmpName);
  const companions = async () => (await readdir(dir)).filter((f) => f.startsWith(`${tmpName}.`));
  try {
    const result = await fn(tmp);
    if (!(await exists(tmp))) throw new Error(`once: fn did not write ${tmp}`);
    for (const f of await companions()) await rename(join(dir, f), `${out}${f.slice(tmpName.length)}`);
    await rename(tmp, out);
    return { path: out, cached: false, result };
  } catch (e) {
    await rm(tmp, { force: true });
    for (const f of await companions()) await rm(join(dir, f), { force: true });
    throw e;
  }
}
