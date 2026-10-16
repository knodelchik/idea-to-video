# F05 — Visuals: identity anchor, keyframes, talking shots (Seedance 2.0)

## Goal
Produce one talking shot per script shot. Consistency comes from construction: a character portrait first, then
keyframes generated *with* it as a reference, then image-to-video from the keyframe. The company asked for
**Seedance 2.0**; it generates video with native, lip-synced speech. Its words are verified by the F04 gate; when
they fail repeatedly, the shot falls back to verified TTS + lip-sync, so the words can't drift.

## Scope
- `src/schemas.ts` — widen `Shot.seconds` to 4–15 (Seedance 2.0 range); keep total 8–30. Update schema tests.
- `src/nodes/visuals.ts`:
  - `castCharacter(script, { image })` → portrait (neutral light, face large, 9:16).
  - `keyframeShot(shot, script, portrait, prev?, { image })` → keyframe with refs `[portrait, prev keyframe?]`.
    `keyframePrompt(shot, script)` (pure, tested): character look + setting + camera + emotion + "photoreal, cinematic,
    vertical 9:16, face clearly visible, mouth closed, no text, no watermark".
  - `talkingShot(shot, keyframe, { video, asr, tts, lipsync, maxNative = 2 })`:
    1. `video.animate({ image: keyframe, line: shot.line, seconds: snapDuration(estimate, capabilities.durations), prompt })`
       where `talkingPrompt(shot, script)` (pure, tested) states the exact line in double quotes, the emotion, a
       locked/slow camera, one speaking face toward camera, "no other speech, no music";
    2. `listen` (F04) on the clip → pass: done;
    3. fail: retry with `variant` up to `maxNative` total; then **fallback**: `verifiedVoice` (F04) →
       `lipsync.sync(bestClip, voice)` → `listen` again. Record every step as an `Attempt` with reason.
    Silent shots (`line === ""`) skip the gate.
  - `snapDuration(seconds, durations)` (pure, tested): smallest allowed duration ≥ seconds; above max → throws.
- `src/providers/seedance.ts` — `VideoProvider` for Seedance 2.0 (`nativeSpeech: true`, durations 4–15 integer,
  9:16, `generate_audio: true`). Two transports chosen by env, because we don't yet know which key we'll get:
  - `SEEDANCE_TRANSPORT=fal`: `@fal-ai/client`, endpoint `bytedance/seedance-2.0/image-to-video` (or `fast`), key `FAL_KEY`;
  - `SEEDANCE_TRANSPORT=byteplus`: BytePlus ModelArk video generation task API (create task → poll → download), key
    `ARK_API_KEY`, model id from `SEEDANCE_MODEL`.
  Read both official docs (fal model page / `llms.txt`; BytePlus ModelArk Seedance 2.0 tutorial + API reference)
  and record the exact field names and URLs in *Decisions*; mark anything you couldn't confirm as unverified in code.
  Map a content-policy rejection (e.g. real-face filter) to a distinct `PolicyRejectedError` (not retried blindly).
- `src/providers/image.ts` — keyframe/portrait `ImageProvider`: `IMAGE_PROVIDER=seedream|fal-nano-banana|gemini`
  (Seedream via the same BytePlus/fal key when available). Same doc-checking rule.
- `src/providers/lipsync.ts` — fallback lip-sync: `LIPSYNC_PROVIDER=fal-kling` (`fal-ai/kling-video/lipsync/audio-to-video`)
  or `command` (an open-source model run locally, e.g. LatentSync, through `LIPSYNC_CMD` with `{video} {audio} {out}`
  placeholders).
- Cost per call in each adapter (from docs) so the manifest and budget guard work.
- `tests/visuals.test.ts`.

## Acceptance
1. `snapDuration(6.2, [4..15]) === 7`; `snapDuration(16, ...)` throws.
2. Keyframe for s2 receives the portrait and s1's keyframe as refs (asserted on the mock call log).
3. Native path: mock video says the line → shot passes after 1 video call, no TTS/lip-sync calls.
4. Native fails twice (fault injection) → exactly `maxNative` video calls, then TTS + lip-sync, final `listen` passes;
   attempts tell the story in order.
5. `PolicyRejectedError` from video is not retried with the same input; the run reports it clearly.
6. `talkingPrompt` contains the line verbatim inside double quotes (test with quotes/apostrophes in the line).
7. Seedance adapter request shape for both transports asserted with injected fakes; no network in tests.
8. `pnpm verify` green.

## Decisions
_(implementer fills in — endpoints, docs URLs, verified yes/no)_
