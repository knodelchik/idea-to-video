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

## Decisions
- **Contracts** (`src/schemas.ts`): `RunManifest` gains `status` (`running|done|failed`), `startedAt`, `endedAt` and
  `redos[] {at, from, costUsd}`. `Attempt` gains `carried`. All four are optional in the schema only so the pre-F19
  example manifests still parse; every manifest the graph writes now has `status` + `startedAt`.
  "interrupted" is not a manifest status: no process can write it about itself. The web server works it out
  (`shownStatus` in `src/web/runs.ts`).
- **Lifecycle.** `runPipeline` writes `running` before the first node, then after each step, then `done`/`failed` with
  `endedAt`. `startedAt` is this process's start: a resume or a redo restarts the clock (the page times the work in
  progress; `createdAt` stays the run's birth). The CLI now picks the run id itself (`newRunId()` when none is given),
  so on a crash outside the nodes (`catch` in `main`) and on SIGINT/SIGTERM (`signals: true`, only at the real
  entry point) it can close a `running` manifest as `failed` (`markEndedSync`). A manifest that already ended is never
  rewritten. SIGKILL can't be caught; that's what "interrupted" is for.
- **Atomic manifest writes** (tmp + rename). Not in the spec, but the new status test read a half-written manifest:
  the graph runs ahead of the loop that writes it, and the web server reads it live. Rejected: retrying reads in
  every reader.
- **Interrupted.** Runs this server spawned: dead when the child has exited (`results`) or its pid is gone
  (`process.kill(pid, 0)`, EPERM = alive). Others: `running`, no `endedAt`, manifest mtime older than 30 min. Elapsed
  time of an interrupted run stops at the manifest's last write.
- **Gallery** now lists runs with any status (running ones open their live progress when clicked). Pre-F19 manifests
  that never finished stay out, as before (the F15 test relies on that, and nobody can follow them anyway).
  `/api/metrics` leaves `running` runs out: they are not failures yet.
- **Elapsed time** is computed on the server (`elapsedMs`, from `startedAt` to `endedAt` or the server's now) and sent
  in every SSE `progress` event, in `/api/runs` items and in `/api/runs/:id`. The page adds local time since the last
  event. Rejected: sending only `startedAt` and diffing with the browser clock (client clock skew).
- **Live calls.** The SSE loop tails `trace.jsonl` by byte offset (`readNewLines`): only complete lines are sent, so a
  span being written is never sent half. Node spans are skipped (attempts already cover nodes). A `call` event carries
  node, shot, kind, provider, model, ok, ms, $, cached/originalCostUsd, the error cut to 160 chars, and a `note`
  (`heard '…'` for ASR, `score n/10` for judges). Never the prompt or the payload.
- **Cost after a redo** (the "simpler" option in the spec): the redo reads the manifest it replaces and carries
  its paid attempts past the fork point (`carriedAttempts`) with `carried: true`. The fork's attempts are a prefix of
  the stored ones (the reducer only appends and the fork is an ancestor), so the slice is exactly what was bought
  after it. Free attempts are not carried. `costUsd` = sum of all attempts, carried included; each redo appends
  `{at, from, costUsd}` with its own new spend. A second redo carries the earlier carried ones again (they sit past the
  fork too), so nothing is lost or counted twice (tested).
- **Budget on a redo** is not charged with the carried spend. That money paid for the pass the redo replaces, and
  counting it would leave a redo of a $2.88 run no room under a $3 cap. A resume still counts its crashed process's
  failures, as before.
- **originalCostUsd** on cached spans: `originalCostLookup(carried)` matches a kept carried attempt with a stage of that
  span kind (video→video, image→portrait/keyframe, …), the provider among the attempt's `+`-joined providers (a spoken
  shot's attempt is `mock-video+mock-asr`), and the same shot. Each attempt answers once. No match → no field. We don't
  guess.
- No new dependencies. Docs checked: Node `fs/promises` `FileHandle.read(buffer, offset, length, position)` and
  `process.kill(pid, 0)` semantics (https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position,
  https://nodejs.org/api/process.html#processkillpid-signal).
