# Progress

Append-only log, one entry per feature, written by the implementer agent and committed by the harness.

## F01 — Contracts and the verbatim gate
- `src/schemas.ts`: Zod schemas + inferred types for `Character`, `Shot`, `Script`, `Transcript`, `VerbatimResult`,
  `Attempt`, `FinalVideo`, `RunManifest`. `Script` enforces 1–2 shots (ids `s1`,`s2`), shots 3–10 s, a total of 8–30 s
  and at least one non-blank line.
- `formatIssues(zodError)` turns a failed parse into `path: message` lines, ready to feed back to a model as the retry reason.
- `src/verbatim.ts`: `normalize(text)` (NFKC, case, apostrophes, dashes, punctuation, numbers/times/ordinals → words;
  spoken symbols spelled out: `& % + = @ °`, `$N`/`€N`/`£N`, `-5` → "minus five"; any other symbol kept as its own token, never dropped),
  `compareWords(expected, heard)` returns `{ wer, ops, pass }`, and `pass` is true only at wer 0.
  `extractQuotedLines(idea)` handles `"…"`, `“…”`, `«…»` and `„…“`.
- Usage: `compareWords(shot.line, transcript.text).pass` is the gate; `ops` says exactly which words differ.
- Tests: `tests/verbatim.test.ts`, `tests/schemas.test.ts`.

## F02 — Provider interfaces, mocks, media toolkit, cache
- `src/providers/types.ts`: `LlmProvider`, `TtsProvider`, `AsrProvider`, `ImageProvider`, `VideoProvider`
  (`capabilities { nativeSpeech, durations }`), `LipsyncProvider`, `TalkingProvider`, and the `Providers` bundle.
  Every result has a `costUsd`. `generateJson` returns `{ ok, data | error, raw, costUsd }` and does not throw on a
  bad shape.
- `createProviders({ mode: "mock", env, overrides })` from `src/providers/index.ts` (the only import door for nodes)
  gives zero-cost ffmpeg mocks. `mode: "live"` throws `NotConfiguredError` naming the missing env var.
- Mocks (`src/providers/mock.ts`): TTS writes a tone wav (0.38 s/word + 0.3 s) and a `.transcript.json` sidecar;
  ASR reads it back. Faults: `new MockAsr({ faults: [{ call, drop | replace | text }] })` and
  `new MockVideo({ faults: [{ call, say }] })`. `MockLlm({ queue })` or `MockLlm({ responder })` records `calls`.
  After muxing speech yourself, call `linkSource(out, source)` (`src/util/sidecar.ts`) so the mock ASR can hear it.
  Lipsync/talking accept such linked audio too. Audio without a sidecar yields a silent output and does not throw.
- Media: `run(args)` and `probe(path)` in `src/media/ffmpeg.ts`. Pure builders in `src/media/args.ts`:
  `normalizeClipArgs`, `muxArgs`, `concatArgs`, `loudnormArgs`, plus `colorImageArgs`, `stillVideoArgs` and
  `toneArgs` for the mocks. Everything comes out 1080×1920 / 30 fps / yuv420p with an exact frame count.
- Cache: `contentKey(...parts)` (strings or `{ file }` hashed by contents) → 16 hex chars.
  `once(out, tmp => …)` returns `{ path, cached, result? }`. It writes atomically, moves sidecars along, cleans up
  after a crash, and dedupes concurrent calls.
- Tests: `tests/media.test.ts`, `tests/providers.mock.test.ts`. Both include real ffmpeg round-trips and take about 3 s.

## F03 — Script writer with deterministic validation
- `writeScript(idea, { llm, maxAttempts = 3 })` (`src/nodes/script.ts`) → `{ script, attempts }`. It asks the LLM for a
  `ScriptDraft`, adds `promptVersion` + code-extracted `quotedLines`, and re-prompts with the previous JSON and the
  problem list. After the last failure it throws `ScriptError { problems, attempts }`.
- `scriptProblems(script, idea)`: exact quoted lines, `quotedLines`, 1–2 shots with ids s1/s2, total 8–30 s,
  `wordCount/2.6 + 0.8 ≤ seconds`, no digits in non-quoted lines, `character.look` ≥ 12 words. One fix-oriented message each.
- Prompt: `src/prompts/script.ts` (`SCRIPT_PROMPT_VERSION`, `SCRIPT_SYSTEM`, `firstPrompt`, `retryPrompt`).
- Live LLM: `GeminiLlm` (`src/providers/gemini.ts`), `GeminiLlm.fromEnv(env)` reads `GEMINI_API_KEY` and `SCRIPT_MODELS`
  (comma list; 429/503 → next model, recorded in `LlmResult.notes`). `createProviders({ mode: "live" })` uses it for `llm`.
- `wordCount(text)` in `src/verbatim.ts` counts spoken (normalised) words.
- Tests: `tests/script.test.ts` (MockLlm + a fake Gemini client; no network).

## F04 — Verbatim gate on speech, with a fallback voice
- `listen(path, expected, { asr })` (`src/nodes/gate.ts`) → `VerbatimResult` + `speechStart`/`speechEnd` (from ASR word
  timestamps) + `transcript` + `costUsd`. Works on audio or video. Delivery tags in `expected` are stripped first.
  `describeOps(ops)` makes the retry reason; `VerbatimError { result, attempts }` is thrown when retries run out.
- `verifiedVoice(line, character, { tts, asr, dir, maxAttempts = 3, emotion?, shotId? })` (`src/nodes/voice.ts`) → a
  `VoiceTrack` (`path, seconds, speechStart, speechEnd, verbatim`) + `attempts` (`stage: "voice"`; a failed attempt
  lists its diff ops). Takes are content-addressed (`dir/voice-<key>.wav`) and reused on resume.
- Emotion goes in `TtsRequest.emotion` and never into the words: `splitDelivery(line)` (`src/verbatim.ts`) separates
  `[tags]`/`<tags>` from the spoken text.
- Live adapters (fake-fetch tested): `GroqAsr` (Whisper verbose_json, word timestamps, `GROQ_API_KEY`, `GROQ_ASR_MODEL`),
  `GeminiTts` (Interactions API, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICES`) and `ElevenLabsTts` (`eleven_v3`, `[tag]`
  prefix, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICES`). `ttsFromEnv` builds a `TtsChain` in `TTS_PROVIDERS` order
  (default `gemini,elevenlabs`; providers without a key are skipped; 429/5xx fall back and are recorded in `notes`).
- `createProviders({ mode: "live" })` now wires `tts` and `asr`. Helpers: `pcmToWav`/`wavSeconds`
  (`src/providers/http.ts`) and `extractAudioArgs` (`src/media/args.ts`).
- Tests: `tests/voice.test.ts` (26 tests: mock ffmpeg round-trips and adapter requests; no network).

## F05 — Visuals: identity anchor, keyframes, talking shots (Seedance 2.0)
- `Shot.seconds` is 4–15 (total still 8–30). The script prompt reads the range from the schema (`script-v2`).
- `src/nodes/visuals.ts`:
  - `castCharacter(script, { image, dir })` and `keyframeShot(shot, script, portrait, prev?, { image, dir })` return
    `{ path, attempts }`. A keyframe's refs are `[portrait, prev?]`.
  - `talkingShot(shot, keyframe, { script, video, asr, tts, lipsync, dir, maxNative = 2 })` returns
    `{ path, seconds, via: silent|native|lipsync, verbatim, speechStart/End, attempts }`. It tries native speech
    (gated) up to `maxNative` times, then falls back to `verifiedVoice` + lip-sync + gate.
  - All artifacts are content-addressed.
- Pure helpers:
  - `snapDuration(seconds, durations)`;
  - `portraitPrompt`, `keyframePrompt`, `talkingPrompt` in `src/prompts/visuals.ts` (the line is quoted verbatim;
    delivery tags go into the emotion).
- Errors:
  - `PolicyRejectedError` (`src/providers/errors.ts`) is never retried. The node throws
    `ShotError { shotId, attempts, cause }`.
  - A lip-synced clip that still fails the gate throws `VerbatimError`.
- Live adapters (fake-tested, no network):
  - `SeedanceVideo` with `SEEDANCE_TRANSPORT=fal` (`FAL_KEY`, `SEEDANCE_TIER=fast`) or `byteplus` (`ARK_API_KEY`,
    `SEEDANCE_MODEL`, `ARK_BASE_URL`; field names UNVERIFIED);
  - `imageFromEnv`: `IMAGE_PROVIDER=fal-nano-banana|gemini|seedream`;
  - `lipsyncFromEnv`: `LIPSYNC_PROVIDER=fal-kling|command`, with `LIPSYNC_CMD` containing `{video} {audio} {out}`.
  - `createProviders("live")` wires all three. `talking` still needs an override.
- Mocks: `calls[]` logs on `MockImage`, `MockVideo`, `MockTts` and `MockLipsync`; `VideoFault.reject` throws
  `PolicyRejectedError`. Tests: `tests/visuals.test.ts` (32 tests).
- A shot's `seconds`/`hasAudio` are always ffprobe-measured on the delivered file: the Seedance download, every
  node clip and the lip-synced output. Adapters supply only `costUsd`.
- The test fake for fal storage returns content-hashed URLs (`upUrl(path)` in `tests/visuals.test.ts`), so tests with
  parallel uploads are deterministic. Use byte-different files when a test checks upload order.

## F05 — Visuals: post-BLOCKED fixes (lip-sync limits, failure attempts)
- Every failure path of `talkingShot` now throws `ShotError` (or `VerbatimError` for a non-verbatim lip-synced
  clip) carrying the full attempt list. ASR errors, lip-sync errors and unexpected errors are recorded as failed
  attempts, with their cost, before the throw.
- `LipsyncProvider.maxSeconds` is now required:
  - Kling: 10;
  - `command`: `Infinity`, or set it with `LIPSYNC_MAX_SECONDS`;
  - `new MockLipsync({ maxSeconds })` rejects longer inputs, like the real API.
- A base clip longer than `maxSeconds` is trimmed to `voice.speechEnd + 0.4` s with `trimArgs` (`src/media/args.ts`)
  and recorded as a `trim` attempt. If even that doesn't fit, a failed `trim` attempt is recorded and a readable
  `ShotError` is thrown; speech is never silently cut.
- `tests/visuals.test.ts` now has 38 tests; `pnpm verify` passes 162 tests.

## F05 — Visuals: silent native takes
- A native clip with no audio stream (ffprobe `hasAudio: false`) is recorded as a failed `video` attempt with
  reason `no audio track`. It is never sent to ASR, and the next take is tried.
- If every native take is silent, the shot falls back to verified TTS + lip-sync on the first silent clip. The
  fallback attempt says "no take had an audio track".
- Tests: `StrictAsr` in `tests/visuals.test.ts` throws on silent input like live Groq; `MockVideo` faults with
  `say: ""` produce silent clips. 40 visuals tests, 164 total in `pnpm verify`.

## F06 — Graph, assembly, final gate, one command
- `pnpm make "<idea>" [--mock|--live] [--resume <runId>] [--json]` (`src/cli.ts`, default `--mock`) writes
  `runs/<runId>/final.mp4` and `runs/<runId>/manifest.json`. `--json` prints one last line
  `{ ok, runId, finalPath, seconds, verbatim: { wer, expected, heard }, costUsd, attempts, manifest }`.
  Exits 0 only when ok. In-process: `main(argv, { runsDir, env, overrides, retry, beforeNode })`.
- `src/graph.ts`: LangGraph `writeScript → cast → drawKeyframes → shot (Send per shot) → assemble → finalGate`,
  checkpointed in `runs/checkpoints.sqlite` (`thread_id = runId`). `runPipeline(req, deps)` returns
  `{ manifest, manifestPath }`. `--resume` skips finished stages without calling their providers.
  Transient errors (`isTransient`, walks `.cause`) are retried with backoff and recorded as `stage:"retry"`
  attempts. Any other failure gives `ok:false` and a readable `error`.
- `src/nodes/assemble.ts`: each shot is cut to `max(script s, speechEnd + 0.4)`, capped at the clip length, and
  normalised to 1080×1920/30 fps (silent shots get generated silence). 50 ms audio fades at the joins, concat,
  then two-pass loudnorm to −16 LUFS. `src/nodes/final-gate.ts` probes for 8–30 s, 1080×1920 and an audio track,
  and listens to the whole file against every line joined.
- Budget: `MAX_COST_USD` (default 3). `withBudget` (`src/providers/budget.ts`) refuses any call whose
  `estimateUsd` would exceed it, before calling. Every live adapter now has `estimateUsd`. `--live` prints the
  estimated cost of a typical run first.
- Mocks: `createProviders("mock")` uses `mockScriptResponder`, so any idea runs. `linkSources(media, [{source,
  offset, until}])` (`src/util/sidecar.ts`) lets the mock ASR hear cut and concatenated files. `RunManifest` now
  has `shots` and `spoken`.
- Tests: `tests/graph.test.ts` (25 tests: the acceptance idea, crash + resume with call counters, final-file
  mishearing, transient vs permanent video errors, budget abort before the first paid call). `pnpm verify` passes
  189 tests, and its mock e2e step is now active. `.env.example` was not updated (see the spec's Blocked note).
