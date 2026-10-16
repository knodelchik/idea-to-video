/**
 * Bench outputs (F09): the markdown table (pure) and the side-by-side grid video. Grid cell k is table row k;
 * rows that failed have no clip and no cell, so the numbering is assigned to successful rows only.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { gridArgs, gridLayout } from "../media/args.ts";
import { probe, run } from "../media/ffmpeg.ts";
import type { BenchRow } from "./run.ts";

export interface BenchReport {
  date: string;
  mode: "mock" | "live";
  line: string;
  keyframe: string;
  voice: { path: string; seconds: number };
  rows: BenchRow[];
  /** Planned total before the run. */
  estimateUsd: number;
  /** Grid file, when at least one row produced a clip. */
  grid?: string;
}

/** Grid cell number (1-based) per row; undefined for rows without a clip. */
export function gridCells(rows: BenchRow[]): (number | undefined)[] {
  let k = 0;
  return rows.map((r) => (r.output && !r.error ? ++k : undefined));
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const num = (n: number | undefined, digits: number): string => (n === undefined ? "—" : n.toFixed(digits));

/** `docs/bench/<date>.md`. Paths are written relative to `base` (the repo root) so the file reads anywhere. */
export function benchMarkdown(r: BenchReport, base = process.cwd()): string {
  const rel = (p: string) => {
    const r = relative(base, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
  };
  const cells = gridCells(r.rows);
  const ok = r.rows.filter((x) => !x.error).length;
  const layout = cells.some((c) => c !== undefined) ? gridLayout(cells.filter((c) => c !== undefined).length) : undefined;
  const header =
    "| # | model | path | provider | clip s | $ registry | $ reported | wall s | WER | judge | heard | output | status | notes |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = r.rows.map((x, i) =>
    [
      cells[i] === undefined ? "—" : String(cells[i]),
      x.id,
      x.path,
      x.provider,
      num(x.seconds, 2),
      num(x.registryUsd, 3),
      num(x.reportedUsd, 3),
      num(x.wallMs / 1000, 1) + (x.cached ? " (cached)" : ""),
      num(x.wer, 2),
      x.clipScore === undefined ? "—" : `${x.clipScore}/10`,
      x.heard === undefined ? "—" : `"${x.heard}"`,
      x.output ? rel(x.output) : "—",
      x.error ? `FAILED: ${x.error}` : x.issues.length ? `ok; ${x.issues.join("; ")}` : "ok",
      "",
    ]
      .map((c) => cell(c))
      .join(" | "),
  );
  const totalRegistry = r.rows.reduce((s, x) => s + x.registryUsd, 0);
  const totalReported = r.rows.reduce((s, x) => s + x.reportedUsd, 0);
  return [
    `# Model bench ${r.date} (${r.mode})`,
    "",
    `- Line: "${r.line}"`,
    `- Keyframe: ${rel(r.keyframe)}`,
    `- Voice (verified verbatim): ${rel(r.voice.path)} (${r.voice.seconds.toFixed(2)} s)`,
    `- Grid: ${r.grid ? rel(r.grid) : "none (no clip was produced)"}${
      layout ? ` (${layout.cols}×${layout.rows}; cell # in reading order, left→right then top→bottom; cell k has k white squares top-left; silent)` : ""
    }`,
    `- Estimated before the run: ~$${r.estimateUsd.toFixed(2)}. Registry total for the models: $${totalRegistry.toFixed(3)}; reported by providers: $${totalReported.toFixed(3)}.`,
    `- ${ok}/${r.rows.length} models produced a clip. WER is the clip's own audio heard by ASR against the line (0 = verbatim). Judge = F07 clip score (3 frames vs the keyframe).`,
    "",
    "`notes` is for the human watching the grid.",
    "",
    header,
    rule,
    ...lines.map((l) => `| ${l} |`),
    "",
  ].join("\n");
}

/** docs/bench/<date>.md (live) / <date>-mock.md; a live run never overwrites an earlier live result. */
export function benchBase(dir: string, date: string, mode: "mock" | "live", exists: (p: string) => boolean = existsSync): string {
  const stem = mode === "mock" ? `${date}-mock` : date;
  if (mode === "mock") return join(dir, stem);
  let base = join(dir, stem);
  for (let k = 2; exists(`${base}.md`); k++) base = join(dir, `${stem}-${k}`);
  return base;
}

/** Writes the grid of every successful row, in table order. Returns its path, or undefined when nothing to show. */
export async function writeGrid(rows: BenchRow[], out: string): Promise<string | undefined> {
  const clips = rows.filter((r) => r.output && !r.error).map((r) => r.output!);
  if (clips.length === 0) return undefined;
  const seconds = Math.max(...(await Promise.all(clips.map(async (c) => (await probe(c)).seconds))));
  await run(gridArgs({ inputs: clips, out, seconds }));
  return out;
}
