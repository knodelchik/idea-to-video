# F19 — Web demo and cost accounting fixes from the first live demo run

## Goal
The author watched a live run in the hosted demo (2026-10-19, run 20261019-121918-6f4903) and found:
1. **The elapsed timer restarts on page reload.** It counts from page load, so you can't tell how long a run has
   taken.
2. **Progress goes silent for minutes.** The page streams manifest attempts, but the manifest only changes when a
   graph node ends. All shots run inside one node for about 6 minutes, so after "judge s3" nothing appeared, though
   the trace (F16) recorded every Seedance call, refusal, ASR and TTS live.
3. **A running run looks failed.** The manifest has `ok: false` until the final gate, so the UI and the API say
   failed while it is still going.
4. **A `--redo` hides money already spent.** After the redo the manifest said $0.14, while the run had really cost
   $2.88. Cached artifacts count $0, and the original spend is lost.

## Scope
- **Run status.** `RunManifest` gets `status: "running"|"done"|"failed"` and `startedAt`, and `endedAt` when it ends.
  The graph writes `running` at the start. The CLI writes `done` or `failed` at exit, also on a crash path. The web API
  and the UI use `status`, never `ok` alone, to label a run. A run with `status: "running"` whose process is gone
  (the server checks the child pid it spawned; for runs it did not spawn, `endedAt` is missing and the manifest is
  older than 30 min) is shown as "interrupted".
- **Timer.** The UI computes elapsed time from `startedAt` (server clock, sent in the API). It keeps counting across
  reloads and stops at `endedAt`.
- **Live progress from the trace.** `/api/runs/:id/events` also tails `trace.jsonl`. It sends each new span as a
  `call` event (kind, provider and model, shot, ok, ms, $, short error) as soon as it is written. The progress list
  shows calls under their node and shot: e.g. "s2 · video · seedance-2.0-fast · refused (real person) → portraits
  only", "s2 · tts · gemini-tts", "s2 · asr · whisper · heard 'tickets'". Attempts stay as today; calls fill the gaps
  between them.
- **Cost after a redo.** The manifest keeps `costUsd` as the true total of everything paid for this run across
  redos:
  - add `costByAttempt` provenance, or simpler: the original manifest's paid attempts are carried into the redo
    manifest as `carried: true`;
  - `costUsd` = new spend + carried spend, and `redos: [{ at, from, costUsd }]` is listed.
  - The trace shows reused artifacts with `cached: true` (F16) and the cost they originally had (`originalCostUsd`)
    when it is known from the carried attempts.

## Acceptance
1. A mock run's manifest goes from `status: "running"` to `done`, with `startedAt`/`endedAt`. A crash goes to `failed`
   with `endedAt`.
2. Web tests:
   - `/api/runs` labels a running run as running, not failed;
   - SSE delivers `call` events from `trace.jsonl` in order while the manifest is unchanged;
   - the elapsed time sent is based on `startedAt`.
3. Redo: a mock run that "paid" $1.20 (fake costs), then `--redo shot` with all clips cached, gives a manifest with
   `costUsd` ≥ 1.20, `redos` of length 1, and carried attempts marked.
4. `pnpm verify` green; F01–F18 tests still pass.
