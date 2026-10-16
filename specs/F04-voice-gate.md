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
- **Contracts first.** `schemas.ts` gains `SpeechWindow` and `VoiceTrack`. A `VoiceTrack` needs `verbatim.pass`, a
  non-empty speech window, and the window inside the track. `TtsRequest` gains `emotion?` (delivery only, never
  in `text`). `TtsResult` gains `provider?` and `notes?`, so a chain fallback reaches the attempt `reason`.
- **Tags never reach the gate.** `splitDelivery(line)` (`src/verbatim.ts`) takes `[…]` (ElevenLabs) and `<…>` (Gemini)
  tags out of the words. `verifiedVoice` sends only the words as TTS `text`, and it joins the tags with the
  `emotion` option into `TtsRequest.emotion`. `listen` strips tags from `expected` as well (defence in depth).
  Rejected alternative: keeping the tags in the text and letting `normalize` drop brackets. The tag words
  ("whispers") would still count as expected words.
- **Return shapes.** `listen` returns `VerbatimResult & { speechStart, speechEnd, transcript, costUsd }`, so `pass` and
  `ops` sit at the top level. When the transcript has no words, the window is `0,0`. `verifiedVoice` returns
  `VoiceTrack & { attempts }`. `VerbatimError { result, attempts }` lives in `src/nodes/gate.ts`, and F05/F06 can
  reuse it for native speech.
- **Retries / idempotence.** Attempt n sends `variant = n − 1`, so the first take is the provider default. Takes go to
  `dir/voice-<contentKey(tts.name, words, voiceKey, emotion, variant)>.wav` through `once()`. A resumed run reuses
  each take without calling TTS again (`reason: "reused cached take"`, cost 0, duration from `probe`). Each attempt has
  `stage: "voice"`, `provider: "<tts>+<asr>"`, and `costUsd` = TTS + ASR. On failure the `reason` lists the diff ops
  (`del "everything" (missing)`).
- **Voices.** `voiceKey(character)` = `"<gender>-<age>"`. Each adapter maps the key to its own voice from a table that
  env can override (`GEMINI_TTS_VOICES`, `ELEVENLABS_VOICES`, both JSON). An unknown key is passed through as a
  literal voice name/id. The Gemini names come from the docs' voice list: Leda, Kore, Gacrux, Puck, Charon, Algenib.
  The ElevenLabs ids are long-standing premade voices but **unverified** per account. Override them before the
  first live run.
- **Groq ASR.** Multipart `POST https://api.groq.com/openai/v1/audio/transcriptions`, `Authorization: Bearer`. Fields:
  `model` (`GROQ_ASR_MODEL`, default `whisper-large-v3`), `response_format=verbose_json`,
  `timestamp_granularities[]=word`, `language=en`, `temperature=0`. **No `prompt`**: priming with the expected line
  would hide errors (research §3). Groq's pages don't show a sample `words[]` array. I used the OpenAI-compatible
  `words: [{word,start,end}]` shape, validated with zod so a different shape fails loudly. Files that aren't
  audio (mp4, mov…) are converted first to 16 kHz mono FLAC with `extractAudioArgs` (pure, tested). Cost is
  $0.111/h with a 10 s minimum per request.
- **Gemini TTS.** The current docs show the **Interactions** REST API, not `generateContent`. The request is
  `POST …/v1beta/interactions` with `x-goog-api-key` and `{model, input:[{type:"user_input",content:[{type:"text",
  text, annotations:[{type:"speech_metadata",style}]}]}], response_format:{type:"audio"},
  generation_config:{speech_config:[{voice}]}}`. Audio is read the way the docs' jq does it: the last `audio` item
  of the `model_output` steps. Unary output is a 24 kHz WAV, and raw PCM gets wrapped. The docs list no seed, so
  retries rely on sampling. Default model `gemini-3.8-flash-tts` (`GEMINI_TTS_MODEL`). Cost is estimated at the
  paid rate (25 audio tokens/s × $9/1M), which over-reports the free tier slightly.
- **ElevenLabs.** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_24000`, `xi-api-key`.
  Body: `{text:"[emotion] line", model_id:"eleven_v3", seed: variant}`. I ask for raw PCM and wrap it as WAV
  (`pcmToWav`), so there's no transcode step and the duration is exact. `voice_settings` and `language_code` are
  left out: the docs don't state v3's allowed values. Cost: $0.08/1k chars.
- **TTS order.** `ttsFromEnv(env)` reads `TTS_PROVIDERS` (default `gemini,elevenlabs`) and skips providers without a key.
  If none is left it throws `NotConfiguredError("tts", "GEMINI_API_KEY or ELEVENLABS_API_KEY")`; an unknown
  name throws. `TtsChain` moves to the next engine only on transient errors (429, 5xx, fetch TypeError) and
  records a note. Other errors are thrown. `createProviders({mode:"live"})` now wires `tts` and `asr`.
- **No new dependencies.** I used Node 22's global `fetch`/`FormData`/`Blob`. Every adapter takes an injected `fetch`.
- Docs checked (2026-10-16): https://console.groq.com/docs/speech-to-text , https://console.groq.com/docs/api-reference ,
  https://ai.google.dev/gemini-api/docs/speech-generation ,
  https://elevenlabs.io/docs/api-reference/text-to-speech/convert ; prices from `docs/research/voice-lipsync-asr.md`.
