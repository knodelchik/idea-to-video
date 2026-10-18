/**
 * npx tsx evals/run.ts --mock|--live [--set ideas|hard] [--limit N] [--ids a,b] [--label text]
 * Runs every eval idea of evals/<set>.jsonl (default ideas.jsonl) through the graph, one at a time, and writes
 * evals/results/<date>-<label>-<mode>.json.
 * Exit 0 when the results file was written (failed ideas are data, not a crash); 2 on bad arguments.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPipeline, type Mode } from "../src/graph.ts";
import { qualityFromEnv } from "../src/nodes/quality.ts";
import { createProviders, maxCostFromEnv, type Env, type Providers } from "../src/providers/index.ts";
import { failedIdea, parseIdeas, resultsTable, summarize, withAggregates, type EvalIdea, type EvalResults, type IdeaResult } from "./metrics.ts";

export const USAGE = "usage: npx tsx evals/run.ts --mock|--live [--set ideas|hard] [--limit N] [--ids a,b] [--label text]";
const HERE = dirname(fileURLToPath(import.meta.url));

export interface EvalArgs {
  mode: Mode;
  limit?: number;
  ids?: string[];
  label: string;
  /** Idea set: evals/<set>.jsonl. Absent = "ideas" (the regular set); "hard" = the F10 stress ideas. */
  set?: string;
}

export function parseEvalArgs(argv: string[]): EvalArgs {
  let mode: Mode | undefined;
  const out: Partial<EvalArgs> = {};
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mock" || a === "--live") {
      const m = a.slice(2) as Mode;
      if (mode && mode !== m) throw new Error("--mock and --live are mutually exclusive");
      mode = m;
    } else if (a === "--limit") {
      const n = Number(value(++i, a));
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
      out.limit = n;
    } else if (a === "--ids") out.ids = value(++i, a).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--label") out.label = value(++i, a);
    else if (a === "--set") {
      const s = value(++i, a);
      // A file name, not a path: only sets that live in evals/.
      if (!/^[a-z0-9-]+$/.test(s)) throw new Error(`--set must be a set name like "hard", got "${s}"`);
      out.set = s;
    }
    else throw new Error(`unknown argument ${a}`);
  }
  // No default mode: an eval of 10 ideas live is real money, so the caller must say which.
  if (!mode) throw new Error("say --mock or --live");
  const label = (out.label ?? "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  return {
    mode,
    label,
    ...(out.limit ? { limit: out.limit } : {}),
    ...(out.ids ? { ids: out.ids } : {}),
    ...(out.set ? { set: out.set } : {}),
  };
}

/** --ids picks (and errors on unknown ids), then --limit truncates. */
export function selectIdeas(all: EvalIdea[], args: Pick<EvalArgs, "ids" | "limit">): EvalIdea[] {
  let picked = all;
  if (args.ids) {
    const unknown = args.ids.filter((id) => !all.some((x) => x.id === id));
    if (unknown.length) throw new Error(`unknown idea id(s): ${unknown.join(", ")}`);
    picked = all.filter((x) => args.ids!.includes(x.id));
  }
  return args.limit ? picked.slice(0, args.limit) : picked;
}

/** evals/results/2026-10-16-baseline-mock.json; a second run the same day gets -2, -3… instead of overwriting. */
export function resultsPath(dir: string, date: Date, label: string, mode: Mode, exists: (p: string) => boolean = existsSync): string {
  const base = `${date.toISOString().slice(0, 10)}-${label}-${mode}`;
  let p = join(dir, `${base}.json`);
  for (let k = 2; exists(p); k++) p = join(dir, `${base}-${k}.json`);
  return p;
}

export interface EvalDeps {
  env?: Env;
  ideasPath?: string;
  resultsDir?: string;
  runsDir?: string;
  overrides?: Partial<Providers>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(argv: string[], deps: EvalDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  let args: EvalArgs;
  let ideas: EvalIdea[];
  try {
    args = parseEvalArgs(argv);
    const path = deps.ideasPath ?? join(HERE, `${args.set ?? "ideas"}.jsonl`);
    if (!existsSync(path)) throw new Error(`no idea set ${args.set ?? "ideas"}: ${path} does not exist`);
    ideas = selectIdeas(parseIdeas(await readFile(path, "utf8")), args);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const maxCostUsd = maxCostFromEnv(env);
  const quality = qualityFromEnv(env);
  const runsDir = resolve(deps.runsDir ?? "runs");

  const rows: IdeaResult[] = [];
  // Sequential on purpose: wall times stay comparable and a live eval never has two paid runs in flight.
  for (const [k, spec] of ideas.entries()) {
    err(`[${k + 1}/${ideas.length}] ${spec.id}`);
    const t0 = performance.now();
    try {
      const o = await runPipeline(
        { idea: spec.idea, mode: args.mode },
        { providers: (mode) => createProviders({ mode, env, overrides: deps.overrides ?? {} }), runsDir, maxCostUsd, quality },
      );
      rows.push(summarize(spec, o.manifest, { manifest: o.manifestPath, wallMs: performance.now() - t0 }));
    } catch (e) {
      rows.push(failedIdea(spec, (e as Error).message, performance.now() - t0));
    }
    const r = rows.at(-1)!;
    const status = r.ok ? "ok" : r.rejected ? `rejected before spending: ${r.error ?? ""}` : `FAILED: ${r.error ?? "unknown"}`;
    err(`  ${status} (${(r.wallMs / 1000).toFixed(1)} s)`);
  }

  const now = (deps.now ?? (() => new Date()))();
  const results: EvalResults = withAggregates({ version: 1, label: args.label, mode: args.mode, createdAt: now.toISOString(), ideas: rows });
  const dir = resolve(deps.resultsDir ?? join(HERE, "results"));
  await mkdir(dir, { recursive: true });
  const path = resultsPath(dir, now, args.label, args.mode);
  await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
  out(resultsTable(results));
  out(`\nresults: ${path}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
