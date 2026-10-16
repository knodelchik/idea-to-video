# F02 — Provider interfaces, mocks, media toolkit, cache

## Goal
Agents and CI must be able to run the *whole* pipeline for free. Every capability sits behind an interface with a
deterministic mock, and media operations are thin, tested wrappers around ffmpeg/ffprobe.

## Scope
- `src/providers/types.ts` — interfaces. Every call takes an explicit `out` path (or returns one) and every result
  carries `costUsd` (0 for mocks):
  - `LlmProvider.generateJson<T>({ system, prompt, schema, temperature? })`
  - `TtsProvider.speak({ text, voice, out, variant? }) → { path, seconds, costUsd }` (`variant` = retry n, lets a
    provider change seed/settings)
  - `AsrProvider.transcribe({ path }) → Transcript & { costUsd }`
  - `ImageProvider.generate({ prompt, refs?, out, variant? }) → { path, costUsd }` (always 9:16)
  - `VideoProvider` with `capabilities { nativeSpeech, durations: number[] }` and
    `animate({ image, prompt, seconds, out, variant? }) → { path, seconds, costUsd }`
  - `LipsyncProvider.sync({ video, audio, out }) → { path, costUsd }`
  - `TalkingProvider.talk({ image, audio, prompt, out }) → { path, costUsd }` (audio-driven avatar models)
- `src/providers/mock.ts` — deterministic mocks built on ffmpeg (no network):
  - TTS: a wav whose length is ~0.38 s/word (+0.3 s), with a sidecar `<file>.transcript.json` holding the text.
  - ASR: reads the sidecar of the file (or of the source it was muxed from); supports fault injection
    `new MockAsr({ faults: [{ call: 0, drop: 1 }] })` to drop/replace words on chosen calls.
  - Image: solid 1080×1920 PNG, colour derived from a hash of the prompt.
  - Video: still → mp4 (30 fps, yuv420p) of the requested seconds with a slow zoom.
  - Lipsync / Talking: mux the given audio onto the video/image; copy the transcript sidecar.
  - LLM: given a `responder(prompt) => object` or a queue of canned objects (tests use this).
- `src/providers/index.ts` — `createProviders({ mode: "mock"|"live", env })` registry (live adapters come later;
  for now live throws `NotConfiguredError` naming the missing env var).
- `src/media/ffmpeg.ts` — `run(args)`, `probe(path) → { seconds, width, height, hasAudio, hasVideo }`.
- `src/media/args.ts` — pure arg builders: `normalizeClipArgs` (scale+crop to 1080×1920, 30 fps, yuv420p, exact
  frame count), `muxArgs` (video + audio, audio delayed by `offset` s, padded/cut to video length), `concatArgs`,
  `loudnormArgs` (−16 LUFS, `anull` when input is silent).
- `src/util/cache.ts` — `contentKey(...parts)` (sha256 over strings and file *contents*), `once(out, fn)`:
  returns existing file, else writes via temp file + rename.
- Tests: `tests/media.test.ts` (arg builders as pure functions + one real ffmpeg round-trip through mocks),
  `tests/providers.mock.test.ts`.

## Acceptance
1. Mock TTS → mock ASR round-trip returns the exact text; with a fault it returns the altered text.
2. Mock image/video/lipsync produce files whose `probe` matches 1080×1920, requested seconds (±1 frame), audio present
   after lipsync.
3. `once` never calls `fn` twice for the same key; a crashed write leaves no partial file.
4. Arg builders are covered by snapshot-free assertions on the important flags.
5. `pnpm verify` green.

## Constraints
- ffmpeg on the dev machine has **no drawtext/libass**; don't depend on them.
- Mocks must be deterministic (same input → byte-identical output is not required, same *probe* result is).

## Decisions
_(implementer fills in)_
