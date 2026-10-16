# F06 — Graph, assembly, final gate, one command

## Goal
`pnpm make "idea"` → `runs/<runId>/final.mp4`, automatically, resumable after a crash, with a manifest that explains
every attempt and dollar. The final file is checked again — by probe *and* by listening to it.

## Scope
- `src/graph.ts` — LangGraph.js `StateGraph`:
  `script → cast → voice → keyframes → shots (Send per shot: clip → sync) → assemble → finalGate`.
  - State: idea, mode, runId, script, portrait, voices{}, keyframes{}, shots{} (reducer merges by shot id), attempts
    (concat reducer), costUsd, final, verbatim, error.
  - Checkpointer: `SqliteSaver` at `runs/checkpoints.sqlite`, `thread_id = runId`.
  - Transient provider errors (HTTP 429/5xx, timeouts — `isTransient(err)`) use the node `retryPolicy` with backoff;
    quality failures are handled inside nodes (F03/F04/F07). A non-transient failure ends the run with
    `ok:false` and a readable `error`, manifest still written.
- `src/nodes/assemble.ts`: per shot normalise video to 1080×1920/30 fps and the shot length; the **audio track is
  our verified TTS** placed at its offset (never the video model's audio); concat; loudnorm −16 LUFS → `final.mp4`.
- `src/nodes/final-gate.ts`: `probe` (8–30 s, 1080×1920, has audio) and ASR of `final.mp4` vs all lines joined →
  `verbatim`. `ok = probe ok && verbatim.pass`.
- `src/cli.ts`: `pnpm make "<idea>" [--mock|--live] [--mode lipsync|talking] [--video-model id] [--resume <runId>] [--json]`.
  Default is `--mock`. `--live` requires the keys of the chosen providers and prints an estimated cost before
  starting; `MAX_COST_USD` (default 3) aborts before a paid call that would exceed it. `--json` prints one final
  line `{ ok, runId, finalPath, seconds, verbatim: { wer, expected, heard }, costUsd, attempts }`. Exit code 0 only if `ok`.
- `runs/<runId>/manifest.json` (RunManifest) written after every node.
- `.env.example` with every key/env var used so far, commented.
- `tests/graph.test.ts`.

## Acceptance
1. Mock run of the acceptance idea exits 0; printed JSON has `ok:true`, `seconds` in 8–30, `verbatim.wer === 0`,
   `verbatim.expected` contains the quoted line exactly.
2. Resume: kill after `keyframes` (test hook / injected throw), resume with `--resume` → providers for finished
   stages are **not** called again (call counters).
3. ASR on the final file returning a wrong word → `ok:false`, exit code ≠ 0, manifest says why.
4. A transient error on the first video call is retried and recorded; a permanent one fails the run cleanly.
5. Budget guard: with `MAX_COST_USD=0.01` and live-priced fake providers, the run aborts before the first paid call.
6. `pnpm verify` green (this enables its mock end-to-end step).

## Decisions
_(implementer fills in)_
