# Evals (F08)

A fixed set of ideas, the same metrics on every run, and a side-by-side comparison of two runs. Use it to tell
whether a prompt, model or retry change made the pipeline better or worse.

```sh
npx tsx evals/run.ts --mock [--limit N] [--ids a,b] [--label text]   # free, any time
pnpm eval --live --label new-prompt                                  # costs money, humans only (loads .env)
npx tsx evals/compare.ts evals/results/<baseline>.json evals/results/<candidate>.json
```

- `ideas.jsonl` holds 10 ideas, `{ id, idea, tags[] }`. Seven quote a line, covering contractions, a number
  ("at 3 a.m."), a name, a question, an exclamation, curly quotes plus an em dash, and a 15-word line. Three quote
  nothing, so the writer invents the line. `tests/evals.test.ts` checks that each tag is actually true of its line.
- `run.ts` runs the ideas one at a time (so wall times are comparable and a live eval never pays for two runs at
  once). It writes `results/<date>-<label>-<mode>.json` (a second run the same day gets `-2`) and prints a table.
  You must pass `--mock` or `--live`; there is no default. An idea that fails is recorded as a failure, never
  dropped. The exit code is 0 whenever the results file was written.
- `compare.ts a b` prints a per-metric delta (b − a) and exits 1 if anything regressed. It recomputes aggregates
  from the per-idea rows, so ratings filled in by hand are counted.

## Metrics

Per idea (`ideas[]`), from the run manifest (`runs/<runId>/manifest.json`, linked as `manifest`):

| Field | Meaning | Source |
| --- | --- | --- |
| `ok` | The final gate passed (8–30 s, 1080×1920, audio, verbatim) | automated |
| `verbatimFirstTry` | Every spoken shot was the first native take, no verbatim-gated take failed, no TTS fallback, and the final file passed | automated |
| `verbatimFinal` | The final file's transcript matched the line(s) exactly (`manifest.verbatim.pass`) | automated |
| `wer` | Word error rate of the final file against the expected line(s) | automated |
| `attemptsByStage` / `msByStage` | Count and summed `ms` of manifest attempts per stage (script, keyframe, judge, video, fallback, voice, lipsync, regen, assemble, final, retry…) | automated |
| `judgeScores` | Every 1–10 score the VLM judge gave (keyframes and clips, including rejected takes) | automated (model) |
| `needsReview` | Some shot kept a take that never passed the judge bar | automated |
| `costUsd`, `seconds`, `wallMs` | Spend, final duration, wall time of the whole run | automated |
| `human` | **1–5 "would you keep watching?"** Watch `runs/<runId>/final.mp4` and type the number in. `null` = not rated | **human** |

Aggregates (`aggregates`):

| Metric | Meaning |
| --- | --- |
| `successRate` | Share of ideas with `ok` |
| `verbatimFirstTryRate` / `verbatimFinalRate` | Share of ideas that passed verbatim on the first try / in the end. Final is the product promise; first try is how much retrying it took |
| `meanAttemptsPerStage` | Mean attempts per idea for each stage (an idea that never reached a stage counts 0) |
| `judge.mean` / `judge.min` | Over all judge scores in the run. Null when nothing was judged |
| `meanSeconds` | Mean duration of successful videos |
| `costPerVideoUsd` | Total spend / ideas run (failures included: that money was spent too) |
| `costPerSuccessUsd` | Total spend / successful videos |
| `stageMs.<stage>.p50/p90` | Per-idea wall time spent in a stage (nearest-rank percentiles) |
| `wallMs.p50/p90/total` | Per-idea end-to-end wall time |
| `needsReviewRate` | Share of ideas with a shot flagged for human review |
| `human.mean` | Mean of the hand-filled ratings (null until someone rates) |

Mock runs always score 8 from the judge and cost $0. They test the plumbing, not quality. Only live runs say
anything about quality, and comparisons are only fair between runs of the same mode on the same ideas
(`compare` warns otherwise).

## Regressions `compare` flags

- `verbatimFinalRate`, `verbatimFirstTryRate` or `successRate` went down at all.
- `costPerVideoUsd` went up more than 20% (from $0, any spend counts).
- `judge.mean` went down by more than 0.5.

Everything else is shown as a delta for a human to read.
