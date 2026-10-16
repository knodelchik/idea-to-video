# F04 — Voice with a verbatim gate

## Goal
The audio is the source of truth for the line. Synthesize it, *listen to it* with ASR, and accept it only if every
word matches. Video later follows this audio (lip-sync), so a passed voice guarantees a verbatim video.

## Scope
- `src/nodes/voice.ts` — `voiceShot(shot, character, { tts, asr, maxAttempts = 3, dir })`:
  for a shot with a non-empty line: `tts.speak` → `asr.transcribe` → `compareWords(line, transcript.text)`.
  Pass → return `{ path, seconds, speechStart, speechEnd, verbatim }` (speech window from ASR word timestamps).
  Fail → retry with `variant = n` (record each `Attempt` with the ops as `reason`). After `maxAttempts` throw
  `VerbatimError` carrying the last `VerbatimResult`. Silent shots return no audio.
- Delivery/emotion goes to the TTS provider as *settings or tags*, never inside the text that is compared.
- Live adapters:
  - `src/providers/elevenlabs.ts` — TTS, model from `ELEVENLABS_MODEL` (default `eleven_v3`), voice id chosen from
    `character.voice` via a small table overridable by env `ELEVENLABS_VOICE_<GENDER>_<AGE>`; emotion as a v3 audio
    tag prefix. Key `ELEVENLABS_API_KEY`.
  - `src/providers/groq-asr.ts` — Whisper (`GROQ_ASR_MODEL`, default `whisper-large-v3`), `verbose_json`, word
    timestamps, `language=en`. Key `GROQ_API_KEY`.
  - Check request/response shapes against the official docs (fetch them) and note the URLs in *Decisions*.
- `tests/voice.test.ts` — mock TTS/ASR with faults; adapters tested through an injected `fetch`.

## Acceptance
1. ASR drops a word on attempt 1 → attempt 2 passes; manifest-style attempts show `ok:false` with the op, then `ok:true`.
2. ASR always wrong → `VerbatimError` with `wer > 0` after exactly `maxAttempts` TTS calls.
3. An emotion tag such as `[whispers]` never reaches `compareWords` as expected text.
4. `speechStart < speechEnd <= seconds` on the mock path.
5. Adapters build the documented request (URL, headers, body fields) — asserted with a fake `fetch`.
6. `pnpm verify` green.

## Decisions
_(implementer fills in)_
