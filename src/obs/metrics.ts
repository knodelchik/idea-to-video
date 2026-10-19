/**
 * Metrics across runs (F16), from manifests plus traces where present. Pure: `loadRuns` (metrics-cli.ts) reads the
 * files, everything here only counts. evals/metrics.ts reuses `percentile` and `verbatimFirstTake`.
 *
 * Fallbacks are counted from attempt stages and reasons that the nodes write (visuals.ts, final-gate.ts); the tests
 * in tests/obs.test.ts pin the phrases so a reworded reason can't silently zero a metric.
 */
import type { RunManifest } from "../schemas.ts";
import type { Span } from "./trace.ts";

export interface RunRecord {
  manifest: RunManifest;
  /** Spans of `trace.jsonl`; absent for runs made before F16. */
  trace?: Span[];
}

/** Nearest-rank percentile (no interpolation: with 3–10 samples it reports a value that actually happened). */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const VERBATIM_STAGES = new Set(["video", "voice", "lipsync", "voiceover"]);

/**
 * Every spoken shot passed the verbatim gate on its first native take (no failed take, no TTS fallback) and so did
 * the final file. A run that never got to its shots has no first take.
 */
export function verbatimFirstTake(m: RunManifest): boolean {
  const spoken = m.script?.shots.filter((s) => s.line.trim() !== "") ?? [];
  return (
    spoken.length > 0 &&
    spoken.every((s) => m.shots?.[s.id]?.audio === "native") &&
    !m.attempts.some((a) => (VERBATIM_STAGES.has(a.stage) && !a.ok) || a.stage === "fallback") &&
    m.verbatim?.pass === true
  );
}

/** Failure text → a bucket: quoted text, numbers, paths and run ids folded, so "the same failure" counts together. */
export function normaliseReason(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/"[^"]*"|“[^”]*”|'[^']*'/g, '"…"')
    .replace(/(?:\/[\w.-]+)+/g, "<path>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

const round = (x: number, d = 4): number => Number(x.toFixed(d));
const rate = (k: number, n: number): number => (n ? round(k / n) : 0);
const spread = (xs: number[]) => ({ p50: percentile(xs, 50), p90: percentile(xs, 90), n: xs.length });

export type Spread = ReturnType<typeof spread>;

export interface ModelCalls {
  provider: string;
  model: string;
  calls: number;
  cached: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Metrics {
  runs: number;
  /** Runs that had a trace.jsonl (model calls and wall times by node come from these). */
  traced: number;
  successRate: number;
  verbatimFirstTakeRate: number;
  finalWerZeroRate: number;
  totalCostUsd: number;
  costPerVideoUsd: number;
  costPerSuccessUsd: number | null;
  wallMs: {
    /** Per run: trace extent (first node start → last node end); summed attempt ms for a run without a trace. */
    run: Spread;
    /** Per stage: node span ms from traces; for untraced runs, summed attempt ms per attempt stage. */
    stage: Record<string, Spread>;
  };
  attemptsPerStage: Record<string, { total: number; meanPerRun: number }>;
  fallbacks: {
    realFaceRefusals: number;
    /** Ladder rungs stepped down to after a refusal. */
    ladderRungs: { refs: number; portraits: number; text: number };
    /** Shots by how their words were made. */
    shotAudio: { native: number; fallback: number; voiceover: number; silent: number };
    /** Spoken shots that used TTS (lip-sync or voice-over) instead of native speech. */
    ttsRate: number;
    silentShotSpeechDropped: number;
    /** Words the final gate's ASR heard in digital silence and ignored (hallucination), and runs where it happened. */
    ignoredInSilence: { words: number; runs: number };
  };
  judge: {
    scores: Record<string, number>;
    mean: number | null;
    failures: number;
    needsReviewRate: number;
  };
  modelCalls: ModelCalls[];
  topFailures: { reason: string; count: number }[];
}

/** Words of the quoted text in a final-gate "digital silence" note (the note keeps up to 120 chars of them). */
function silenceWords(reason: string): number {
  const m = /digital silence[^"]*"([^"]*)"/.exec(reason);
  return m ? m[1]!.split(/\s+/).filter(Boolean).length : 0;
}

function runWall(r: RunRecord): number {
  const nodes = (r.trace ?? []).filter((s) => s.kind === "node");
  if (nodes.length) {
    const start = Math.min(...nodes.map((s) => Date.parse(s.startedAt)));
    const end = Math.max(...nodes.map((s) => Date.parse(s.startedAt) + s.ms));
    return end - start;
  }
  return r.manifest.attempts.reduce((s, a) => s + a.ms, 0);
}

export function metrics(records: RunRecord[]): Metrics {
  const ms = records.map((r) => r.manifest);
  const n = ms.length;
  const ok = ms.filter((m) => m.ok).length;
  const total = ms.reduce((s, m) => s + m.costUsd, 0);
  const attempts = ms.flatMap((m) => m.attempts);

  // Wall time per stage: node spans when traced, attempt ms otherwise.
  const stageMs: Record<string, number[]> = {};
  const push = (k: string, v: number) => (stageMs[k] ??= []).push(v);
  for (const r of records) {
    const nodes = (r.trace ?? []).filter((s) => s.kind === "node");
    if (nodes.length) {
      for (const s of nodes) push(s.node, s.ms);
    } else {
      const per: Record<string, number> = {};
      for (const a of r.manifest.attempts) per[a.stage] = (per[a.stage] ?? 0) + a.ms;
      for (const [k, v] of Object.entries(per)) push(k, v);
    }
  }

  const attemptsPerStage: Metrics["attemptsPerStage"] = {};
  for (const a of attempts) (attemptsPerStage[a.stage] ??= { total: 0, meanPerRun: 0 }).total++;
  for (const v of Object.values(attemptsPerStage)) v.meanPerRun = round(v.total / n, 3);

  const reasons = (stage: string) => attempts.filter((a) => a.stage === stage).map((a) => a.reason ?? "");
  const video = reasons("video");
  const stepDowns = video.filter((r) => /refused as a possible real person/.test(r));
  const shotAudio = { native: 0, fallback: 0, voiceover: 0, silent: 0 };
  for (const m of ms) for (const s of Object.values(m.shots ?? {})) if (s) shotAudio[s.audio]++;
  const spoken = shotAudio.native + shotAudio.fallback + shotAudio.voiceover;
  const finals = reasons("final");

  const judged = attempts.filter((a) => a.stage === "judge");
  const scores: Record<string, number> = {};
  for (const a of judged) if (a.score !== undefined) scores[a.score] = (scores[a.score] ?? 0) + 1;
  const scored = judged.flatMap((a) => (a.score !== undefined ? [a.score] : []));

  const calls = new Map<string, ModelCalls>();
  for (const s of records.flatMap((r) => r.trace ?? [])) {
    if (s.kind === "node") continue;
    const model = s.model ?? "-";
    const key = `${s.provider}\u0000${model}`;
    const c = calls.get(key) ?? { provider: s.provider, model, calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    c.calls++;
    if (s.cached) c.cached++;
    if (!s.ok) c.failed++;
    c.inputTokens += s.usage?.input ?? 0;
    c.outputTokens += (s.usage?.output ?? 0) + (s.usage?.thinking ?? 0);
    c.costUsd = round(c.costUsd + s.costUsd, 6);
    calls.set(key, c);
  }

  const failures = new Map<string, number>();
  const fail = (r: string) => failures.set(normaliseReason(r), (failures.get(normaliseReason(r)) ?? 0) + 1);
  for (const a of attempts) if (!a.ok && a.reason) fail(`${a.stage}: ${a.reason}`);
  for (const m of ms) if (m.error) fail(`run: ${m.error}`);

  return {
    runs: n,
    traced: records.filter((r) => r.trace?.length).length,
    successRate: rate(ok, n),
    verbatimFirstTakeRate: rate(ms.filter(verbatimFirstTake).length, n),
    finalWerZeroRate: rate(ms.filter((m) => m.verbatim?.wer === 0).length, n),
    totalCostUsd: round(total, 6),
    costPerVideoUsd: n ? round(total / n, 6) : 0,
    costPerSuccessUsd: ok ? round(total / ok, 6) : null,
    wallMs: {
      run: spread(records.map(runWall)),
      stage: Object.fromEntries(Object.entries(stageMs).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, spread(v)])),
    },
    attemptsPerStage,
    fallbacks: {
      realFaceRefusals: stepDowns.length + video.filter((r) => /rejected by content policy/.test(r) && /real person|PrivacyInformation/i.test(r)).length,
      ladderRungs: {
        // "…with the portraits only" also says "reference-to-video": test it first.
        portraits: stepDowns.filter((r) => /retrying as reference-to-video with the portraits only/.test(r)).length,
        refs: stepDowns.filter((r) => /retrying as reference-to-video$/.test(r)).length,
        text: stepDowns.filter((r) => /retrying as text-to-video/.test(r)).length,
      },
      shotAudio,
      ttsRate: rate(shotAudio.fallback + shotAudio.voiceover, spoken),
      silentShotSpeechDropped: reasons("listen").filter((r) => /audio replaced with silence/.test(r)).length,
      ignoredInSilence: {
        words: finals.reduce((s, r) => s + silenceWords(r), 0),
        runs: ms.filter((m) => m.attempts.some((a) => a.stage === "final" && /digital silence/.test(a.reason ?? ""))).length,
      },
    },
    judge: {
      scores,
      mean: scored.length ? round(scored.reduce((s, x) => s + x, 0) / scored.length, 3) : null,
      failures: judged.filter((a) => /^judge failed/.test(a.reason ?? "")).length,
      needsReviewRate: rate(ms.filter((m) => Object.values(m.shots ?? {}).some((s) => s?.needsReview)).length, n),
    },
    modelCalls: [...calls.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
    topFailures: [...failures.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 10),
  };
}

const usd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(4)}`);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const sec = (s: Spread) => `p50 ${(s.p50 / 1000).toFixed(1)} s, p90 ${(s.p90 / 1000).toFixed(1)} s`;

/** Human-readable report for `pnpm metrics`. */
export function formatMetrics(m: Metrics): string {
  const f = m.fallbacks;
  const lines = [
    `runs ${m.runs} (traced ${m.traced}), success ${pct(m.successRate)}, verbatim first take ${pct(m.verbatimFirstTakeRate)}, final WER=0 ${pct(m.finalWerZeroRate)}`,
    `cost: total ${usd(m.totalCostUsd)}, per video ${usd(m.costPerVideoUsd)}, per successful video ${usd(m.costPerSuccessUsd)}`,
    `wall per run: ${sec(m.wallMs.run)}`,
    ...Object.entries(m.wallMs.stage).map(([k, s]) => `  ${k}: ${sec(s)}`),
    `attempts per stage: ${Object.entries(m.attemptsPerStage).map(([k, v]) => `${k} ${v.total} (${v.meanPerRun}/run)`).join(", ")}`,
    `real-face refusals ${f.realFaceRefusals}; ladder rungs: refs ${f.ladderRungs.refs}, portraits ${f.ladderRungs.portraits}, text ${f.ladderRungs.text}`,
    `shots: native ${f.shotAudio.native}, lip-sync ${f.shotAudio.fallback}, voice-over ${f.shotAudio.voiceover}, silent ${f.shotAudio.silent}; TTS rate ${pct(f.ttsRate)}`,
    `silent-shot speech dropped ${f.silentShotSpeechDropped}; ASR words ignored in silence ${f.ignoredInSilence.words} (in ${f.ignoredInSilence.runs} runs)`,
    `judge: mean ${m.judge.mean ?? "-"}, scores ${JSON.stringify(m.judge.scores)}, failures ${m.judge.failures}, needs review ${pct(m.judge.needsReviewRate)}`,
    `model calls:`,
    ...m.modelCalls.map((c) => `  ${c.provider} ${c.model}: ${c.calls} calls (${c.cached} cached, ${c.failed} failed), ${c.inputTokens}/${c.outputTokens} tok, ${usd(c.costUsd)}`),
    `top failures:`,
    ...m.topFailures.map((x) => `  ${x.count}× ${x.reason}`),
  ];
  return lines.join("\n");
}
