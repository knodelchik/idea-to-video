/**
 * Eval metrics (F08): manifest → per-idea summary → aggregates → comparison of two runs.
 * Everything here is pure so it can be unit-tested without running the pipeline.
 */
import { z } from "zod";
import type { RunManifest } from "../src/schemas.ts";

export const EvalIdea = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  idea: z.string().trim().min(1),
  tags: z.array(z.string()),
});
export type EvalIdea = z.infer<typeof EvalIdea>;

/** Parse `ideas.jsonl`: one idea per non-empty line, ids unique. Errors name the line. */
export function parseIdeas(text: string): EvalIdea[] {
  const out: EvalIdea[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const r = EvalIdea.safeParse(JSON.parse(line));
    if (!r.success) throw new Error(`ideas.jsonl line ${i + 1}: ${r.error.issues.map((x) => x.message).join("; ")}`);
    if (out.some((x) => x.id === r.data.id)) throw new Error(`ideas.jsonl line ${i + 1}: duplicate id ${r.data.id}`);
    out.push(r.data);
  });
  return out;
}

const StageCounts = z.record(z.string(), z.number().min(0));

export const IdeaResult = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  idea: z.string(),
  runId: z.string().nullable(),
  manifest: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().optional(),
  /**
   * The PoC deliberately refused the idea before any paid call (F10 pre-spend check: non-English line, nested
   * quotes, a line no shot can hold). A clean, $0 rejection — not a crash and not a pipeline failure.
   */
  rejected: z.boolean().optional(),
  /** Every spoken shot passed the verbatim gate on its first native take (no failed take, no TTS fallback). */
  verbatimFirstTry: z.boolean(),
  /** The final file passed the verbatim gate (manifest.verbatim.pass). */
  verbatimFinal: z.boolean(),
  wer: z.number().nullable(),
  seconds: z.number().nullable(),
  costUsd: z.number().min(0),
  attemptsByStage: StageCounts,
  /** Summed attempt `ms` per stage for this run. */
  msByStage: StageCounts,
  judgeScores: z.array(z.number()),
  needsReview: z.boolean(),
  wallMs: z.number().min(0),
  /** Human: 1–5 "would you keep watching", filled in by hand. null = not rated yet. */
  human: z.number().int().min(1).max(5).nullable(),
});
export type IdeaResult = z.infer<typeof IdeaResult>;

const Spread = z.object({ p50: z.number(), p90: z.number() });

export const Aggregates = z.object({
  n: z.number().int().min(0),
  successRate: z.number(),
  verbatimFirstTryRate: z.number(),
  verbatimFinalRate: z.number(),
  meanAttemptsPerStage: StageCounts,
  judge: z.object({ mean: z.number(), min: z.number(), n: z.number().int() }).nullable(),
  meanSeconds: z.number().nullable(),
  /** Total spend / ideas run: what one attempt at a video costs, failures included. */
  costPerVideoUsd: z.number(),
  /** Total spend / successful videos. null when nothing succeeded. */
  costPerSuccessUsd: z.number().nullable(),
  stageMs: z.record(z.string(), Spread),
  wallMs: Spread.extend({ total: z.number() }),
  needsReviewRate: z.number(),
  human: z.object({ mean: z.number(), n: z.number().int() }).nullable(),
});
export type Aggregates = z.infer<typeof Aggregates>;

export const EvalResults = z.object({
  version: z.literal(1),
  label: z.string(),
  mode: z.enum(["mock", "live"]),
  createdAt: z.string(),
  ideas: z.array(IdeaResult),
  aggregates: Aggregates,
});
export type EvalResults = z.infer<typeof EvalResults>;

const VERBATIM_STAGES = new Set(["video", "voice", "lipsync"]);
/** Attempt provider of the script node's pre-spend rejection (src/nodes/script.ts). */
export const PRE_SPEND_PROVIDER = "pre-spend-check";

/** One finished (or failed) run → the numbers we track. */
export function summarize(spec: EvalIdea, m: RunManifest, extra: { manifest: string; wallMs: number }): IdeaResult {
  const attemptsByStage: Record<string, number> = {};
  const msByStage: Record<string, number> = {};
  for (const a of m.attempts) {
    attemptsByStage[a.stage] = (attemptsByStage[a.stage] ?? 0) + 1;
    msByStage[a.stage] = (msByStage[a.stage] ?? 0) + a.ms;
  }
  const spoken = m.script?.shots.filter((s) => s.line.trim() !== "") ?? [];
  // First try = no verbatim-gated take failed and no shot needed the TTS fallback. A run that never got to
  // its shots (script failure) has no first try.
  const firstTry =
    spoken.length > 0 &&
    spoken.every((s) => m.shots?.[s.id]?.audio === "native") &&
    !m.attempts.some((a) => (VERBATIM_STAGES.has(a.stage) && !a.ok) || a.stage === "fallback");
  const shots = Object.values(m.shots ?? {});
  return {
    id: spec.id,
    tags: spec.tags,
    idea: spec.idea,
    runId: m.runId,
    manifest: extra.manifest,
    ok: m.ok,
    ...(m.error !== undefined ? { error: m.error } : {}),
    ...(m.attempts.some((a) => a.provider === PRE_SPEND_PROVIDER) ? { rejected: true } : {}),
    verbatimFirstTry: firstTry && m.verbatim?.pass === true,
    verbatimFinal: m.verbatim?.pass === true,
    wer: m.verbatim?.wer ?? null,
    seconds: m.final?.seconds ?? null,
    costUsd: m.costUsd,
    attemptsByStage,
    msByStage,
    judgeScores: m.attempts.flatMap((a) => (a.stage === "judge" && a.score !== undefined ? [a.score] : [])),
    needsReview: shots.some((s) => s?.needsReview === true),
    wallMs: Math.round(extra.wallMs),
    human: null,
  };
}

/** A run that threw before it had a manifest (setup error). Counted as a failure, never dropped. */
export function failedIdea(spec: EvalIdea, error: string, wallMs: number): IdeaResult {
  return {
    id: spec.id,
    tags: spec.tags,
    idea: spec.idea,
    runId: null,
    manifest: null,
    ok: false,
    error,
    verbatimFirstTry: false,
    verbatimFinal: false,
    wer: null,
    seconds: null,
    costUsd: 0,
    attemptsByStage: {},
    msByStage: {},
    judgeScores: [],
    needsReview: false,
    wallMs: Math.round(wallMs),
    human: null,
  };
}

/** Nearest-rank percentile (no interpolation: with 3–10 samples it reports a value that actually happened). */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const round = (x: number, d = 4): number => Number(x.toFixed(d));

export function aggregate(ideas: IdeaResult[]): Aggregates {
  const n = ideas.length;
  const rate = (f: (r: IdeaResult) => boolean) => (n ? round(ideas.filter(f).length / n) : 0);
  const stages = [...new Set(ideas.flatMap((r) => Object.keys(r.attemptsByStage)))].sort();
  const meanAttemptsPerStage: Record<string, number> = {};
  const stageMs: Record<string, { p50: number; p90: number }> = {};
  for (const st of stages) {
    // Ideas that never reached a stage count as 0 attempts: the mean is per idea run, comparable across runs.
    meanAttemptsPerStage[st] = round(mean(ideas.map((r) => r.attemptsByStage[st] ?? 0)), 3);
    const ms = ideas.flatMap((r) => (r.msByStage[st] !== undefined ? [r.msByStage[st]!] : []));
    stageMs[st] = { p50: percentile(ms, 50), p90: percentile(ms, 90) };
  }
  const scores = ideas.flatMap((r) => r.judgeScores);
  const secs = ideas.flatMap((r) => (r.ok && r.seconds !== null ? [r.seconds] : []));
  const total = ideas.reduce((s, r) => s + r.costUsd, 0);
  const ok = ideas.filter((r) => r.ok).length;
  const walls = ideas.map((r) => r.wallMs);
  const rated = ideas.flatMap((r) => (r.human !== null ? [r.human] : []));
  return {
    n,
    successRate: rate((r) => r.ok),
    verbatimFirstTryRate: rate((r) => r.verbatimFirstTry),
    verbatimFinalRate: rate((r) => r.verbatimFinal),
    meanAttemptsPerStage,
    judge: scores.length ? { mean: round(mean(scores), 3), min: Math.min(...scores), n: scores.length } : null,
    meanSeconds: secs.length ? round(mean(secs), 3) : null,
    costPerVideoUsd: n ? round(total / n, 6) : 0,
    costPerSuccessUsd: ok ? round(total / ok, 6) : null,
    stageMs,
    wallMs: { p50: percentile(walls, 50), p90: percentile(walls, 90), total: walls.reduce((s, x) => s + x, 0) },
    needsReviewRate: rate((r) => r.needsReview),
    human: rated.length ? { mean: round(mean(rated), 3), n: rated.length } : null,
  };
}

/** Recompute aggregates from the per-idea rows (after a human filled in ratings, say). */
export function withAggregates(r: Omit<EvalResults, "aggregates">): EvalResults {
  return { ...r, aggregates: aggregate(r.ideas) };
}

// --- comparison ---

export interface CompareRow {
  metric: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  regression: boolean;
  /** Why it was flagged. */
  why?: string;
}

/** Regression thresholds. Verbatim is the product's promise, so any drop counts. */
export const THRESHOLDS = { costUpPct: 20, judgeMeanDown: 0.5 } as const;

/** a = baseline, b = candidate. Rows for every headline metric; `regression` marks the ones that got worse. */
export function compare(a: EvalResults, b: EvalResults): CompareRow[] {
  const A = a.aggregates;
  const B = b.aggregates;
  const rows: CompareRow[] = [];
  const row = (metric: string, x: number | null, y: number | null, bad?: (x: number, y: number) => string | undefined) => {
    const delta = x !== null && y !== null ? round(y - x, 6) : null;
    const why = x !== null && y !== null ? bad?.(x, y) : undefined;
    rows.push({ metric, a: x, b: y, delta, regression: why !== undefined, ...(why ? { why } : {}) });
  };
  const down = (what: string) => (x: number, y: number) => (y < x ? `${what} went down` : undefined);

  row("successRate", A.successRate, B.successRate, down("success rate"));
  row("verbatimFirstTryRate", A.verbatimFirstTryRate, B.verbatimFirstTryRate, down("verbatim first-try pass rate"));
  row("verbatimFinalRate", A.verbatimFinalRate, B.verbatimFinalRate, down("verbatim final pass rate"));
  row("judge.mean", A.judge?.mean ?? null, B.judge?.mean ?? null, (x, y) =>
    x - y > THRESHOLDS.judgeMeanDown ? `mean judge score down more than ${THRESHOLDS.judgeMeanDown}` : undefined,
  );
  row("judge.min", A.judge?.min ?? null, B.judge?.min ?? null);
  row("costPerVideoUsd", A.costPerVideoUsd, B.costPerVideoUsd, (x, y) =>
    // From $0 (mock) any spend is an increase of more than 20%.
    y > x * (1 + THRESHOLDS.costUpPct / 100) ? `cost per video up more than ${THRESHOLDS.costUpPct}%` : undefined,
  );
  row("costPerSuccessUsd", A.costPerSuccessUsd, B.costPerSuccessUsd);
  row("meanSeconds", A.meanSeconds, B.meanSeconds);
  row("needsReviewRate", A.needsReviewRate, B.needsReviewRate);
  row("human.mean", A.human?.mean ?? null, B.human?.mean ?? null);
  row("wallMs.p50", A.wallMs.p50, B.wallMs.p50);
  row("wallMs.p90", A.wallMs.p90, B.wallMs.p90);
  const stages = [...new Set([...Object.keys(A.meanAttemptsPerStage), ...Object.keys(B.meanAttemptsPerStage)])].sort();
  for (const st of stages) row(`attempts.${st}`, A.meanAttemptsPerStage[st] ?? 0, B.meanAttemptsPerStage[st] ?? 0);
  for (const st of stages) row(`ms.${st}.p50`, A.stageMs[st]?.p50 ?? null, B.stageMs[st]?.p50 ?? null);
  return rows;
}

// --- text tables ---

export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const fmt = (x: number | null, d = 3): string => (x === null ? "-" : String(Number(x.toFixed(d))));

export function resultsTable(r: EvalResults): string {
  const yn = (b: boolean) => (b ? "y" : "n");
  const perIdea = table(
    ["id", "ok", "verb 1st", "verb final", "attempts", "judge min", "sec", "usd", "wall s"],
    r.ideas.map((i) => [
      i.id,
      i.rejected ? "rejected" : yn(i.ok),
      yn(i.verbatimFirstTry),
      yn(i.verbatimFinal),
      String(Object.values(i.attemptsByStage).reduce((s, x) => s + x, 0)),
      i.judgeScores.length ? String(Math.min(...i.judgeScores)) : "-",
      fmt(i.seconds, 2),
      fmt(i.costUsd, 4),
      fmt(i.wallMs / 1000, 1),
    ]),
  );
  const g = r.aggregates;
  const agg = table(
    ["metric", "value"],
    [
      ["ideas", String(g.n)],
      ["success rate", fmt(g.successRate)],
      ["verbatim pass (first try)", fmt(g.verbatimFirstTryRate)],
      ["verbatim pass (final)", fmt(g.verbatimFinalRate)],
      ["judge mean / min", g.judge ? `${fmt(g.judge.mean)} / ${g.judge.min}` : "-"],
      ["mean duration s", fmt(g.meanSeconds, 2)],
      ["cost per video $", fmt(g.costPerVideoUsd, 4)],
      ["cost per success $", fmt(g.costPerSuccessUsd, 4)],
      ["needs review rate", fmt(g.needsReviewRate)],
      ["wall s p50 / p90", `${fmt(g.wallMs.p50 / 1000, 1)} / ${fmt(g.wallMs.p90 / 1000, 1)}`],
      ...Object.entries(g.meanAttemptsPerStage).map(([st, x]) => [
        `${st}: attempts, ms p50/p90`,
        `${fmt(x, 2)}, ${g.stageMs[st]?.p50 ?? "-"}/${g.stageMs[st]?.p90 ?? "-"}`,
      ]),
    ],
  );
  return `${perIdea}\n\n${agg}`;
}

export function compareTable(rows: CompareRow[]): string {
  return table(
    ["metric", "a", "b", "delta", "flag"],
    rows.map((r) => [r.metric, fmt(r.a, 4), fmt(r.b, 4), r.delta === null ? "-" : (r.delta > 0 ? "+" : "") + fmt(r.delta, 4), r.regression ? `REGRESSION: ${r.why}` : ""]),
  );
}
