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
    `animate({ image, prompt, seconds, out, line?, refs?, variant? }) → { path, seconds, hasAudio, costUsd }`.
    `line` is the exact text the character must say when the model speaks natively (Seedance 2.0 does).
  - `LipsyncProvider.sync({ video, audio, out }) → { path, costUsd }`
  - `TalkingProvider.talk({ image, audio, prompt, out }) → { path, costUsd }` (audio-driven avatar models)
- `src/providers/mock.ts` — deterministic mocks built on ffmpeg (no network):
  - TTS: a wav whose length is ~0.38 s/word (+0.3 s), with a sidecar `<file>.transcript.json` holding the text.
  - ASR: reads the sidecar of the file (or of the source it was muxed from); supports fault injection
    `new MockAsr({ faults: [{ call: 0, drop: 1 }] })` to drop/replace words on chosen calls.
  - Image: solid 1080×1920 PNG, colour derived from a hash of the prompt.
  - Video: still → mp4 (30 fps, yuv420p) of the requested seconds with a slow zoom. With `nativeSpeech` and a
    `line`, it also adds an audio track and a transcript sidecar holding the line; fault injection
    `new MockVideo({ faults: [{ call: 0, say: "a paraphrase" }] })` makes it "say" something else on chosen calls.
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
- **No new dependencies.** ffmpeg/ffprobe via `node:child_process.execFile` (no shell, so no quoting bugs).
  Local ffmpeg 8.1.1 has `zoompan`, `loudnorm`, `apad`, `sine`, `color`; nothing uses drawtext/libass.
- **LLM result is a union, not a throw:** `generateJson` returns `{ ok: true, data, raw, costUsd } | { ok: false,
  error, raw, costUsd }`. `error` is `formatIssues()` output, so F03 can re-prompt with it, and the cost of a bad
  answer still gets recorded in `attempts[]`. Rejected: throwing on a bad shape (the cost would be lost and every
  caller would need try/catch). MockLlm round-trips responses through JSON, as a real model's text would.
- **Speech travels in sidecars.** `<media>.transcript.json` (word timings included). For audio muxed by
  pipeline code (not a mock), `linkSource(out, source)` in `src/util/sidecar.ts` writes `<out>.source.json`, and
  `MockAsr` follows it. Lipsync and talking carry speech over by resolving the audio's transcript through
  `readTranscript` (links followed) and writing it onto the output. If the audio has no transcript, they write none,
  so the output stays silent. A file with no sidecar transcribes as `""` (silence). A missing file throws.
  Rejected (attempt 1): a plain `copyFile` of `<audio>.transcript.json`. It threw ENOENT for linked or silent audio,
  so the `copyTranscript` helper was removed.
- **Fault shapes.** `AsrFault { call, drop?: n trailing words, replace?: {word: new}, text?: whole text }`, where
  `call` is the 0-based transcribe() index on that instance. `VideoFault { call, say }`. Mock speech starts 0.3 s into
  a clip, and words that would start after the clip ends are cut from the transcript (a real model gets cut off
  too, and later gates need to see that).
- **MockVideo** defaults to `nativeSpeech: true` and `durations: 4..15`, matching Seedance 2.0 per F05. It **throws** on
  a duration that isn't in `durations`, so snapping bugs can't hide behind a forgiving mock. MockImage and MockVideo
  check that `refs` exist.
- **`once(out, fn)`** returns `{ path, cached, result? }`. tmp = `<name>.tmp-<pid>-<rand><ext>` so ffmpeg still sees
  the extension. Companion files `fn` writes next to tmp (`<tmp>.transcript.json`) are renamed to `<out>.*`
  **before** the main file, so if `out` exists its sidecars do too. Concurrent calls in the same process share
  one `fn`. On a throw, tmp and its companions are deleted.
- **`contentKey`** takes strings/numbers/booleans and `{ file }` (hashed by contents). Each part is tagged and
  length-prefixed (so `"ab","c"` ≠ `"a","bc"`). It returns 16 hex chars.
- **Media flags:** `normalizeClipArgs` uses scale-to-cover + crop (no letterbox), `tpad` clone and `-frames:v N`
  (an exact frame count even when the source is slightly short), and `audio: boolean` (the caller probes first,
  because mapping audio that doesn't exist makes ffmpeg error). `muxArgs` needs the video `seconds` (`adelay`,
  `apad`, `atrim`, `-t`). Negative offsets are rejected. `concatArgs` uses the concat *filter* (re-encode).
  `concatArgs` and `loudnormArgs` add `-shortest`, because AAC frame padding pushed the audio 30–100 ms past the
  video end (measured: 3.029 s → 3.1 s after loudnorm on a 3.0 s video). One-pass loudnorm `I=-16:TP=-1.5:LRA=11`.
- **Live mode** checks the env vars named in F03–F05 (`GEMINI_API_KEY`, `GROQ_API_KEY`, `FAL_KEY`) and throws
  `NotConfiguredError(capability, envVar)` for the first one missing. With all keys set it still throws, because
  no live adapter exists yet (no silent fallback to mocks). `overrides` lets tests and later features inject
  providers.
- Docs checked: ffmpeg filters documentation (https://ffmpeg.org/ffmpeg-filters.html: zoompan, tpad, adelay
  `all=1`, apad, atrim, concat, loudnorm), plus `ffmpeg -filters` on the dev machine.
