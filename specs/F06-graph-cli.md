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
- **Graph** (`src/graph.ts`): `Annotation.Root` state; `shots`/`keyframes` merge by shot id, `attempts` concat,
  `costUsd` sum. Node names are `writeScript`, `cast`, `drawKeyframes`, `shot`, `assemble`, `finalGate`. LangGraph
  refuses a node name that is also a state key, so the spec's `script`/`keyframes` were renamed. Each shot is one
  `Send("shot", {runId, script, shot, keyframe})`. The payload is that task's whole input.
- **Retries**: every node has `retryPolicy {maxAttempts 3, initialInterval 2 s, backoff ×2, jitter, retryOn: isTransient}`.
  `isTransient` walks `.cause`, because `talkingShot` wraps provider errors in `ShotError`. It returns true for
  HTTP 429/5xx, `fetch failed` TypeErrors, `TimeoutError`, ETIMEDOUT/ECONNRESET/… Any other TypeError is a bug
  and is not retried.
  LangGraph drops a failed task's output. A node wrapper therefore keeps the failed attempts under the task key,
  adds a `stage:"retry"` attempt, and prepends both to the successful retry's patch. If the run fails, they go
  into the manifest. On `--resume`, the crashed process's failed attempts are carried over from the old manifest
  (the attempts after the checkpointed ones).
- **Resume**: `SqliteSaver.fromConnString(runs/checkpoints.sqlite)`, `thread_id = runId`, `stream(null)`. A spike
  showed that a finished sibling Send task's writes are kept and only the failed task re-runs. The mode comes
  from the checkpoint, so `--resume` with `--mock/--live` is rejected. Parallel failures arrive as one
  "Multiple errors occurred during superstep N" error; `runError` lists the individual messages instead.
- **Manifest**: written on every `streamMode:"values"` step (once per superstep) and once more at the end from
  `getState()`, which is the source of truth. `costUsd` is the sum of all recorded attempts. `RunManifest` gained
  optional `shots` (`ShotOutput`: path, seconds, audio `native|fallback|silent`, speech window, verbatim) and
  `spoken {expected, heard}` (raw text). Contracts were changed first, in `src/schemas.ts`.
- **CLI JSON**: `verbatim.expected/heard` are the *raw* texts. `VerbatimResult.expected` is normalised
  (lower-case, no punctuation), so it could not "contain the quoted line exactly". `attempts` is the count; the
  full list is in the manifest, whose path is also printed. A usage error exits 2, any failed run exits 1.
- **Budget**: `estimateUsd?(req)` is optional on every provider interface and is implemented for each live
  adapter, from the price constants they already use for `costUsd`. `withBudget(providers, Budget)` checks
  `spent + in-flight reservations + estimate > MAX_COST_USD` *before* each call. Zero-estimate calls (mocks) are
  never refused. A resumed run starts with the spend from its checkpoint.
  `--live` prints `estimateRunUsd` (1 script call, 3 images, 2×8 s video, 3 ASR calls) before starting.
  Rejected alternative: estimating only up front. It can't stop a retry loop that runs over the cap.
- **Assembly**: `cutSeconds = min(clip, max(script seconds, speechEnd + 0.4))`. `segmentArgs` normalises the
  clip, generates `anullsrc` audio for silent shots so every segment can be concatenated, and adds 50 ms audio
  fades on each segment edge. The "short crossfade" is therefore fade-out + fade-in at the cut, not
  `acrossfade`/`xfade`: those overlap segments, which shortens the film (an 8 s script would land under 8 s)
  and moves the next shot's speech off its lips.
  Loudness is **two-pass** loudnorm (measure → `linear=true` with the measured values, then `aresample,apad` so
  `-shortest` cuts at the video end). One-pass dynamic only raised the quiet mock audio from −36.5 to −35 LUFS;
  two-pass reaches −15.8 LUFS. Intermediates are content-addressed; `final.mp4` is a copy of the last one.
- **Mock "ASR" of the final file**: `linkSources(media, [{source, offset, until}])` in `src/util/sidecar.ts`.
  Assembly records how each file was cut and joined, and `readTranscript` shifts and cuts words to match, so
  the mock hears the final file as a real ASR would.
- **Mock script writer**: `mockScriptResponder` is the default mock LLM, so `pnpm make --mock` works for any idea
  without a canned queue. It reads the idea and quoted lines back out of the prompt. With one line: a silent 4 s
  shot, then the line. With two lines: one per shot. With none: `MOCK_DEFAULT_LINE`.
- No new dependencies. The LangGraph/SQLite packages were already in package.json.
- Docs checked: the installed type definitions (`@langchain/langgraph` 1.5 `RetryPolicy`, `addNode` options, `Send`;
  `@langchain/langgraph-checkpoint-sqlite` 1.1 `SqliteSaver.fromConnString`, `.db`) and ffmpeg's loudnorm
  two-pass docs (https://ffmpeg.org/ffmpeg-filters.html#loudnorm).

## Blocked (partial, not an acceptance item)
- `.env.example` could not be updated. This agent's permission settings deny reading `.env*` files, and the file
  must be read before it can be edited. A human should make sure it lists, grouped by stage:
  - script: `GEMINI_API_KEY`, `SCRIPT_MODELS`
  - voice: `TTS_PROVIDERS`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICES`, `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL`,
    `ELEVENLABS_VOICES`
  - ASR: `GROQ_API_KEY`, `GROQ_ASR_MODEL`
  - images: `IMAGE_PROVIDER`, `FAL_KEY`, `GEMINI_IMAGE_MODEL`, `ARK_API_KEY`, `SEEDREAM_MODEL`, `SEEDREAM_SIZE`,
    `ARK_BASE_URL`
  - video: `SEEDANCE_TRANSPORT`, `SEEDANCE_TIER`, `SEEDANCE_MODEL` (+ `FAL_KEY` / `ARK_API_KEY`, `ARK_BASE_URL`)
  - lip-sync: `LIPSYNC_PROVIDER`, `LIPSYNC_CMD`, `LIPSYNC_MAX_SECONDS` (+ `FAL_KEY`)
  - run: `MAX_COST_USD` (default 3)
