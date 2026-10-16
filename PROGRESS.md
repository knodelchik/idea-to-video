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
