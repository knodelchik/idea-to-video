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
- **Layout.** All pure logic is in `evals/metrics.ts`: `parseIdeas`, `summarize(manifest)`, `aggregate`,
  `compare`, and the table formatters. `run.ts` and `compare.ts` are thin CLIs with injectable `main(argv, deps)`.
  `tests/evals.test.ts` (20 tests) covers the pure functions and runs one mock idea end to end.
- **Results contract.** It is a zod `EvalResults` (version 1) in `evals/metrics.ts`, not in `src/schemas.ts`.
  It is not a contract between pipeline stages, and keeping it out of `src/` keeps the pipeline unaware of evals.
  `compare` validates both files against it.
- **Verbatim first try** is defined from the manifest, not from a new field. Every spoken shot must have
  `audio: "native"`, no `video`/`voice`/`lipsync` attempt may be `ok: false`, there must be no `fallback` attempt,
  and the final gate must pass. **Final** is `manifest.verbatim.pass`. I rejected adding a first-try flag to the
  manifest: the attempts already record it, and a new field would only be set by new runs.
- **Per-stage numbers.** Mean attempts are averaged per idea run, and a stage the idea never reached counts 0, so
  runs with different failure points stay comparable. Wall time per stage is the per-idea sum of attempt `ms`, then
  nearest-rank p50/p90. With 3–10 samples, interpolated percentiles would report times that never happened.
- **Cost** is reported two ways: `costPerVideoUsd` (spend / ideas, failures included, which is the one the
  regression rule uses) and `costPerSuccessUsd`. From a $0 baseline, any spend counts as a >20% increase.
- **Regressions.** I implemented the spec's three rules and added "success rate down". A drop in success rate is
  unambiguous and costs nothing to flag. `compare.ts` exits 1 on any regression so it can gate a change.
- **Other choices.**
  - `--mock`/`--live` is required, with no default: ten live runs are real money.
  - Ideas run sequentially.
  - A results file is never overwritten (`-2`, `-3` suffixes).
  - A pipeline setup error becomes a failed row instead of crashing the eval.
  - `compare` recomputes aggregates from the rows, so hand-filled `human` ratings count without a re-run.
- **Ideas.** Seven quoted ideas and three unquoted. One idea combines curly quotes and an em dash. The long line has
  15 words. A test checks that each tag is true of the extracted line, so the tags can't drift from the text.
- **Package scripts.** `pnpm eval` (`tsx --env-file-if-exists=.env evals/run.ts`, so a human's `--live` run gets
  keys) and `pnpm eval:compare`. `tsconfig.json` already included `evals/`.
- **Dependencies.** None added. **Docs checked.** None external; the code uses only the repo's own
  `runPipeline`, `createProviders` and `RunManifest`.
- **Evidence.**
  - `npx tsx evals/run.ts --mock --limit 3` exits 0 and writes `evals/results/2026-10-16-run-mock.json`.
  - A full mock run is in `evals/results/2026-10-16-baseline-mock.json`: 10/10 ok, verbatim 1.0/1.0, judge 8/8, $0.
  - `compare` on these two files prints "no regressions", plus a warning that they cover different ideas.
