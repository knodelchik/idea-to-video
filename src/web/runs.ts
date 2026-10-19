/**
 * Reading runs and examples from disk for the web demo (F15). Every id from a URL goes through `inside()`: it must
 * match `^[\w-]+$` and the resolved path must stay inside its folder, so `..%2F..` never reaches the filesystem.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
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

/**
 * A run is over once its status says so (F19). Manifests from before F19 have no status: over once the final gate
 * decided (ok) or an error was recorded.
 */
export const isFinished = (m: RunManifest): boolean => (m.status ? m.status !== "running" : m.ok || m.error !== undefined);

/** What the page shows. `interrupted` = the manifest says running but no process is working on it any more. */
export type ShownStatus = "running" | "done" | "failed" | "interrupted";

/** A run nobody spawned here, still `running` and untouched this long, is taken as dead (the graph writes per step). */
export const STALE_MS = 30 * 60 * 1000;

export interface Liveness {
  /** For a run this server spawned: is its process still there? undefined = not ours, decide by age. */
  alive?: boolean;
  /** Last write of the manifest. */
  mtimeMs?: number;
  now: number;
}

export function shownStatus(m: RunManifest, l: Liveness): ShownStatus {
  const s = m.status ?? (m.ok ? "done" : m.error !== undefined ? "failed" : "running");
  if (s !== "running") return s;
  if (l.alive !== undefined) return l.alive ? "running" : "interrupted";
  if (!m.endedAt && l.mtimeMs !== undefined && l.now - l.mtimeMs > STALE_MS) return "interrupted";
  return "running";
}

/**
 * How long the run took, or has taken so far, by the server clock: startedAt → endedAt, or → now while it runs, or →
 * the manifest's last write when it was interrupted. Null without startedAt (manifests from before F19).
 */
export function elapsedMs(m: RunManifest, status: ShownStatus, l: Liveness): number | null {
  if (!m.startedAt) return null;
  const end = m.endedAt ? Date.parse(m.endedAt) : status === "interrupted" && l.mtimeMs !== undefined ? l.mtimeMs : l.now;
  return Math.max(0, end - Date.parse(m.startedAt));
}

export interface RunView {
  status: ShownStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedMs: number | null;
}

export function runView(m: RunManifest, l: Liveness): RunView {
  const status = shownStatus(m, l);
  return { status, ...(m.startedAt ? { startedAt: m.startedAt } : {}), ...(m.endedAt ? { endedAt: m.endedAt } : {}), elapsedMs: elapsedMs(m, status, l) };
}

export async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Complete lines appended to `path` since byte `offset`. A line still being written (no "\n" yet) waits for the next
 * call, so a span is never sent half. No file yet = nothing new.
 */
export async function readNewLines(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], offset };
    throw e;
  }
  try {
    const size = (await fh.stat()).size;
    if (size <= offset) return { lines: [], offset };
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    const lines = buf.subarray(0, end).toString("utf8").split("\n").filter((l) => l.trim());
    return { lines, offset: offset + end + 1 };
  } finally {
    await fh.close();
  }
}

const short = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the progress list needs from one provider span (F19 `call` event): who, what, how it went, never the payload. */
export function callEvent(s: Span, index: number) {
  const text = typeof s.response?.text === "string" ? s.response.text : undefined;
  const verdict = s.response?.verdict as { score?: unknown } | undefined;
  const note = s.cached
    ? "cached"
    : s.kind === "asr" && s.ok && text !== undefined
      ? `heard '${short(text.trim(), 80)}'`
      : s.kind === "judge" && typeof verdict?.score === "number"
        ? `score ${verdict.score}/10`
        : undefined;
  return {
    index,
    node: s.node,
    ...(s.shotId ? { shotId: s.shotId } : {}),
    kind: s.kind,
    provider: s.provider,
    ...(s.model ? { model: s.model } : {}),
    ok: s.ok,
    ms: s.ms,
    costUsd: s.costUsd,
    ...(s.cached ? { cached: true } : {}),
    ...(s.originalCostUsd !== undefined ? { originalCostUsd: s.originalCostUsd } : {}),
    ...(s.error ? { error: short(s.error) } : {}),
    ...(note ? { note } : {}),
  };
}

export interface GalleryItem extends RunView {
  id: string;
  kind: "run" | "example";
  title: string;
  idea: string;
  mode: "mock" | "live";
  /** The final gate's verdict; false while running. Label a run by `status`, never by this alone (F19). */
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

export function galleryItem(id: string, kind: GalleryItem["kind"], m: RunManifest, view: RunView): GalleryItem {
  const seconds = m.final?.seconds ?? null;
  const first = m.script?.shots[0]?.seconds ?? 2;
  const thumb = Math.min(first / 2, seconds ? seconds / 2 : first / 2);
  return {
    ...view,
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
  /** Last write of the manifest (F19: a `running` run nobody touched for 30 min is interrupted). */
  mtimeMs?: number;
}

/** Every readable manifest: run folders and examples. Unreadable ones are reported, never silently dropped. */
export async function loadAll(runsDir: string, examplesDir: string, log: (l: string) => void = () => {}): Promise<Loaded[]> {
  const out: Loaded[] = [];
  const add = async (id: string, kind: Loaded["kind"], dir: string, path: string) => {
    try {
      const m = await readManifest(path);
      const mtimeMs = await mtimeOf(path);
      if (m) out.push({ id, kind, manifest: m, dir, ...(mtimeMs !== undefined ? { mtimeMs } : {}) });
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

/**
 * Runs and examples, newest first. Runs with a status (F19) are listed whatever it is, labelled by it; a pre-F19
 * manifest that never finished is a leftover snapshot nobody can follow, and stays out as before.
 */
export function gallery(all: Loaded[], view: (x: Loaded) => RunView): GalleryItem[] {
  return all
    .filter((x) => x.kind === "example" || x.manifest.status !== undefined || isFinished(x.manifest))
    .map((x) => galleryItem(x.id, x.kind, x.manifest, view(x)))
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
