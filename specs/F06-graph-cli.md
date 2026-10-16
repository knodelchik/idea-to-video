# F06 — Graph, assembly, final gate, one command

## Goal
`pnpm make "idea"` → `runs/<runId>/final.mp4`, automatically, resumable after a crash, with a manifest that explains
every attempt and dollar. The final file is checked again — by probe *and* by listening to it.

## Scope
- `src/graph.ts` — LangGraph.js `StateGraph`:
  `script → cast → keyframes (sequential: s2 uses s1) → shots (Send per shot: talkingShot) → assemble → finalGate`.
  - State: idea, mode, runId, script, portrait, keyframes{}, shots{} (reducer merges by shot id: clip path, audio
    source "native"|"fallback", speech window, verbatim), attempts (concat reducer), costUsd, final, verbatim, error.
  - Checkpointer: `SqliteSaver` at `runs/checkpoints.sqlite`, `thread_id = runId`.
  - Transient provider errors (HTTP 429/5xx, timeouts — `isTransient(err)`) use the node `retryPolicy` with backoff;
    quality failures are handled inside nodes (F03/F04/F05/F07). A non-transient failure ends the run with
    `ok:false` and a readable `error`; the manifest is still written.
- `src/nodes/assemble.ts`: per shot normalise video to 1080×1920/30 fps, cut to the shot length (at least speechEnd +
  0.4 s); keep each shot's own (verified) audio; concat with short audio crossfades; loudnorm −16 LUFS → `final.mp4`.
- `src/nodes/final-gate.ts`: `probe` (8–30 s, 1080×1920, has audio) and ASR of `final.mp4` vs all lines joined →
  `verbatim`. `ok = probe ok && verbatim.pass`.
- `src/cli.ts`: `pnpm make "<idea>" [--mock|--live] [--resume <runId>] [--json]`. Default `--mock`. `--live` needs the
  keys of the configured providers and prints the estimated cost before starting; `MAX_COST_USD` (default 3) aborts
  before a paid call that would exceed it. `--json` prints one final line
  `{ ok, runId, finalPath, seconds, verbatim: { wer, expected, heard }, costUsd, attempts }`. Exit 0 only if `ok`.
- `runs/<runId>/manifest.json` (RunManifest) written after every node.
- `.env.example` — every env var used anywhere, commented, grouped by stage.
- `tests/graph.test.ts`.

## Acceptance
1. Mock run of the acceptance idea exits 0; JSON has `ok:true`, `seconds` in 8–30, `verbatim.wer === 0`,
   `verbatim.expected` contains the quoted line exactly.
2. Resume: inject a throw after `keyframes`, resume with `--resume` → providers for finished stages are **not**
   called again (call counters).
3. ASR on the final file returning a wrong word → `ok:false`, exit code ≠ 0, manifest says why.
4. A transient error on the first video call is retried and recorded; a permanent one fails the run cleanly.
5. Budget guard: with `MAX_COST_USD=0.01` and live-priced fake providers, the run aborts before the first paid call.
6. `pnpm verify` green (this enables its mock end-to-end step).

## Decisions
_(implementer fills in)_
