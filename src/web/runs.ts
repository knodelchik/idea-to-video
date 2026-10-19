/**
 * Reading runs and examples from disk for the web demo (F15). Every id from a URL goes through `inside()`: it must
 * match `^[\w-]+$` and the resolved path must stay inside its folder, so `..%2F..` never reaches the filesystem.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseTrace } from "../obs/metrics-cli.ts";
import type { RunRecord } from "../obs/metrics.ts";
import type { Span } from "../obs/trace.ts";
import { RunManifest } from "../schemas.ts";

export const ID_RE = /^[\w-]+$/;

/** `dir/name` if `name` is a plain id and the path stays inside `dir`; otherwise null (the caller answers 400). */
export function inside(dir: string, name: string, suffix = ""): string | null {
  if (!ID_RE.test(name)) return null;
  const base = resolve(dir);
  const p = resolve(base, `${name}${suffix}`);
  return p.startsWith(base + sep) ? p : null;
}

export type Source = { kind: "run" | "example"; dir: string; manifest: string };

/** Where a run's files are: a run folder first, else an example (`<id>.manifest.json`). Null for a bad id. */
export function sourcesOf(runsDir: string, examplesDir: string, id: string): Source[] | null {
  const run = inside(runsDir, id);
  const example = inside(examplesDir, id, ".manifest.json");
  if (!run || !example) return null;
  return [
    { kind: "run", dir: run, manifest: join(run, "manifest.json") },
    { kind: "example", dir: resolve(examplesDir), manifest: example },
  ];
}

export class BadManifest extends Error {}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** The manifest, validated. undefined = no such file; BadManifest = there, but not JSON or not the contract. */
export async function readManifest(path: string): Promise<RunManifest | undefined> {
  const text = await readOptional(path);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BadManifest(`${path}: not JSON (yet)`);
  }
  const r = RunManifest.safeParse(json);
  if (!r.success) throw new BadManifest(`${path}: does not match the RunManifest contract`);
  return r.data;
}

export async function findRun(runsDir: string, examplesDir: string, id: string): Promise<{ source: Source; manifest: RunManifest } | null | undefined> {
  const sources = sourcesOf(runsDir, examplesDir, id);
  if (!sources) return null;
  for (const source of sources) {
    const manifest = await readManifest(source.manifest);
    if (manifest) return { source, manifest };
  }
  return undefined;
}

export async function readRunTrace(runDir: string): Promise<Span[]> {
  const text = await readOptional(join(runDir, "trace.jsonl"));
  return text === undefined ? [] : parseTrace(text);
}

/** A run is over once the final gate decided (ok) or an error was recorded; in-flight manifests have neither. */
export const isFinished = (m: RunManifest): boolean => m.ok || m.error !== undefined;

export interface GalleryItem {
  id: string;
  kind: "run" | "example";
  title: string;
  idea: string;
  mode: "mock" | "live";
  ok: boolean;
  seconds: number | null;
  costUsd: number;
  wer: number | null;
  /** A frame worth showing before play: the middle of the first shot (the `#t=` of the poster frame). */
  thumbTime: number;
  videoUrl: string | null;
  createdAt: string;
  attempts: number;
}

export function galleryItem(id: string, kind: GalleryItem["kind"], m: RunManifest): GalleryItem {
  const seconds = m.final?.seconds ?? null;
  const first = m.script?.shots[0]?.seconds ?? 2;
  const thumb = Math.min(first / 2, seconds ? seconds / 2 : first / 2);
  return {
    id,
    kind,
    title: m.script?.title ?? m.idea.slice(0, 60),
    idea: m.idea,
    mode: m.mode,
    ok: m.ok,
    seconds,
    costUsd: m.costUsd,
    wer: m.verbatim?.wer ?? null,
    thumbTime: Number(thumb.toFixed(2)),
    videoUrl: m.final ? (kind === "run" ? `/media/${id}/final.mp4` : `/media/examples/${id}.mp4`) : null,
    createdAt: m.createdAt,
    attempts: m.attempts.length,
  };
}

async function dirNames(dir: string, dirs: boolean): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => (dirs ? e.isDirectory() : e.isFile())).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export interface Loaded {
  id: string;
  kind: GalleryItem["kind"];
  manifest: RunManifest;
  dir: string;
}

/** Every readable manifest: run folders and examples. Unreadable ones are reported, never silently dropped. */
export async function loadAll(runsDir: string, examplesDir: string, log: (l: string) => void = () => {}): Promise<Loaded[]> {
  const out: Loaded[] = [];
  const add = async (id: string, kind: Loaded["kind"], dir: string, path: string) => {
    try {
      const m = await readManifest(path);
      if (m) out.push({ id, kind, manifest: m, dir });
    } catch (e) {
      log(`skipped ${kind} ${id}: ${(e as Error).message}`);
    }
  };
  for (const name of await dirNames(runsDir, true)) {
    if (ID_RE.test(name)) await add(name, "run", join(runsDir, name), join(runsDir, name, "manifest.json"));
  }
  for (const file of await dirNames(examplesDir, false)) {
    const id = file.endsWith(".manifest.json") ? file.slice(0, -".manifest.json".length) : "";
    if (ID_RE.test(id)) await add(id, "example", examplesDir, join(examplesDir, file));
  }
  return out;
}

/** Finished runs plus examples, newest first. */
export function gallery(all: Loaded[]): GalleryItem[] {
  return all
    .filter((x) => x.kind === "example" || isFinished(x.manifest))
    .map((x) => galleryItem(x.id, x.kind, x.manifest))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Records for `metrics()` (F16): manifests plus the traces of run folders. */
export async function records(all: Loaded[]): Promise<RunRecord[]> {
  return Promise.all(
    all.map(async (x) => {
      if (x.kind === "example") return { manifest: x.manifest };
      const text = await readOptional(join(x.dir, "trace.jsonl"));
      return { manifest: x.manifest, ...(text !== undefined ? { trace: parseTrace(text) } : {}) };
    }),
  );
}
