/**
 * npx tsx evals/compare.ts <baseline.json> <candidate.json>
 * Per-metric delta table. Exit 1 when any metric regressed, so it can gate a change; 2 on bad input.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compare, compareTable, EvalResults, withAggregates } from "./metrics.ts";

export const USAGE = "usage: npx tsx evals/compare.ts <baseline.json> <candidate.json>";

export async function load(path: string): Promise<EvalResults> {
  const r = EvalResults.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!r.success) throw new Error(`${path}: not an eval results file (${r.error.issues[0]?.message ?? "invalid"})`);
  // Recompute from the rows: a human may have filled in `human` ratings by hand since the file was written.
  return withAggregates(r.data);
}

type Sink = (line: string) => void;

export async function main(
  argv: string[],
  out: Sink = (l) => void process.stdout.write(`${l}\n`),
  err: Sink = (l) => void process.stderr.write(`${l}\n`),
): Promise<number> {
  if (argv.length !== 2) {
    err(USAGE);
    return 2;
  }
  let a: EvalResults;
  let b: EvalResults;
  try {
    [a, b] = await Promise.all([load(argv[0]!), load(argv[1]!)]);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (a.mode !== b.mode) err(`warning: comparing a ${a.mode} run with a ${b.mode} run`);
  const ids = (r: EvalResults) => r.ideas.map((i) => i.id).sort().join(",");
  if (ids(a) !== ids(b)) err("warning: the two runs cover different ideas; rates are not like for like");
  const rows = compare(a, b);
  out(`a: ${a.label} (${a.mode}, ${a.createdAt}, ${a.aggregates.n} ideas)\nb: ${b.label} (${b.mode}, ${b.createdAt}, ${b.aggregates.n} ideas)\n`);
  out(compareTable(rows));
  const bad = rows.filter((r) => r.regression);
  out(bad.length ? `\n${bad.length} regression(s): ${bad.map((r) => r.metric).join(", ")}` : "\nno regressions");
  return bad.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
