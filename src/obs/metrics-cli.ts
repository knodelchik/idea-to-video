/**
 * pnpm metrics [runsDir] [--json]
 * Reads every `<runsDir>/<id>/manifest.json` (+ `trace.jsonl` where present) and prints the metrics of src/obs/metrics.ts.
 * Unreadable manifests are skipped and listed, never silently dropped.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RunManifest } from "../schemas.ts";
import { formatMetrics, metrics, type RunRecord } from "./metrics.ts";
import type { Span } from "./trace.ts";

export interface LoadedRuns {
  records: RunRecord[];
  /** `<dir>: why` for every run folder whose manifest could not be used. */
  skipped: string[];
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** A crash can leave a half-written last line; complete lines are still spans. */
export function parseTrace(text: string): Span[] {
  const out: Span[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Span);
    } catch {
      // partial line from a crash: skip it
    }
  }
  return out;
}

export async function loadRuns(runsDir: string): Promise<LoadedRuns> {
  const records: RunRecord[] = [];
  const skipped: string[] = [];
  const entries = (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of entries) {
    const text = await readOptional(join(runsDir, name, "manifest.json"));
    if (text === undefined) continue; // not a run folder
    let manifest: RunManifest;
    try {
      const parsed = RunManifest.safeParse(JSON.parse(text));
      if (!parsed.success) {
        skipped.push(`${name}: manifest does not match the contract`);
        continue;
      }
      manifest = parsed.data;
    } catch {
      skipped.push(`${name}: manifest is not JSON`);
      continue;
    }
    const trace = await readOptional(join(runsDir, name, "trace.jsonl"));
    records.push({ manifest, ...(trace !== undefined ? { trace: parseTrace(trace) } : {}) });
  }
  return { records, skipped };
}

export async function main(argv: string[], out: (l: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const json = argv.includes("--json");
  const dirs = argv.filter((a) => a !== "--json");
  if (dirs.length > 1 || dirs.some((d) => d.startsWith("--"))) {
    out("usage: pnpm metrics [runsDir] [--json]");
    return 2;
  }
  const dir = resolve(dirs[0] ?? "runs");
  let loaded: LoadedRuns;
  try {
    loaded = await loadRuns(dir);
  } catch (e) {
    out(`error: cannot read ${dir}: ${(e as Error).message}`);
    return 1;
  }
  const m = metrics(loaded.records);
  if (json) out(JSON.stringify({ ...m, skipped: loaded.skipped }, null, 2));
  else {
    out(formatMetrics(m));
    if (loaded.skipped.length) out(`skipped ${loaded.skipped.length}:\n${loaded.skipped.map((s) => `  ${s}`).join("\n")}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
