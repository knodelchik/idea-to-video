# F08 — Eval set and regression runs

## Goal
See whether the pipeline gets better: run a fixed set of ideas, collect the same metrics every time, compare two
runs side by side.

## Scope
- `evals/ideas.jsonl` — 10 ideas, each `{ id, idea, tags[] }`. At least 6 contain a quoted line, covering:
  contractions, a number ("at 3 a.m."), a name, a question, an exclamation, curly quotes, an em dash, a long line
  (14–18 words). The rest have no quote (the writer invents the line).
- `evals/run.ts --mock|--live [--limit N] [--ids a,b] [--label text]` — runs the graph per idea (sequentially),
  writes `evals/results/<date>-<label>-<mode>.json` with per-idea manifest summaries and aggregates:
  success rate, verbatim pass rate (first try and final), mean attempts per stage, judge scores (mean/min), duration,
  cost per video, wall time per stage (p50/p90). Prints a compact table.
- `evals/compare.ts a.json b.json` — per-metric delta table, flags regressions (verbatim pass rate down, cost up >20%,
  mean judge score down >0.5).
- `evals/README.md` — what each metric means, which are automated vs human (human: a 1–5 "would you keep watching"
  rating column in the results file, filled in by hand).
- Tests for the aggregate + compare functions (`tests/evals.test.ts`).

## Acceptance
1. `npx tsx evals/run.ts --mock --limit 3` exits 0 and writes a results file with the aggregates above.
2. `compare` flags an injected regression in a test.
3. `pnpm verify` green.

## Decisions
_(implementer fills in)_
