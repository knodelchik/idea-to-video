# F04 — Verbatim gate on speech, with a fallback voice

## Goal
The product rule is "the line is heard word for word". The main path lets the video model (Seedance 2.0) speak the
line natively — best acting and lip-sync in one pass, but the words are *sampled*, so nothing is trusted until ASR
has listened to it. When native speech keeps failing, a fallback produces a verified voice track that a lip-sync
step (F05) puts on the video.

## Scope
- `src/nodes/gate.ts` — `listen(path, expected, { asr })` → `VerbatimResult` (+ ASR word timestamps → `speechStart`,
  `speechEnd`). Works on any audio or video file (ASR adapters extract audio with ffmpeg when needed).
- `src/nodes/voice.ts` — fallback voice: `verifiedVoice(line, character, { tts, asr, maxAttempts = 3, dir })`:
  `tts.speak` → `listen` → pass returns `{ path, seconds, speechStart, speechEnd, verbatim }`; fail retries with
  `variant = n`; after `maxAttempts` throws `VerbatimError` with the last result. Every try is an `Attempt` with the
  diff ops as `reason`. Emotion/delivery goes to the provider as settings or tags, never into the compared text.
- Live adapters (shapes checked against official docs — put URLs in *Decisions*):
  - `src/providers/groq-asr.ts` — Whisper (`GROQ_ASR_MODEL`, default `whisper-large-v3`), `verbose_json`, word
    timestamps, `language=en`. Key `GROQ_API_KEY`. (Free tier.)
  - `src/providers/gemini-tts.ts` — Gemini TTS (free tier; `GEMINI_TTS_MODEL`, voice by `character.voice`).
  - `src/providers/elevenlabs.ts` — optional, `eleven_v3`, voice table overridable by env, emotion as an audio-tag
    prefix. Key `ELEVENLABS_API_KEY`.
  - TTS order from env `TTS_PROVIDERS` (default `gemini,elevenlabs`; a provider without a key is skipped).
- `tests/voice.test.ts`.

## Acceptance
1. `listen` on a mock clip whose sidecar says a paraphrase returns `pass:false` with the right op; on the exact line,
   `pass:true` and `0 <= speechStart < speechEnd`.
2. Fallback voice: ASR drops a word on attempt 1 → attempt 2 passes; attempts show `ok:false` (with the op), then `ok:true`.
3. ASR always wrong → `VerbatimError` with `wer > 0` after exactly `maxAttempts` TTS calls.
4. An emotion tag such as `[whispers]` never reaches `compareWords` as expected text.
5. Adapters build the documented request (URL, headers, body fields), asserted with an injected fake `fetch`;
   no network in tests.
6. `pnpm verify` green.

## Decisions
_(implementer fills in)_
