# F05 — Visuals: identity anchor, keyframes, clips, lip-sync

## Goal
Produce one talking shot per script shot. Consistency comes from construction: a character portrait first, then
keyframes generated *with* it as a reference, then image-to-video from the keyframe. The mouth is driven by our
verified audio, so the words can't drift.

## Scope
- `src/nodes/visuals.ts`:
  - `castCharacter(script, { image })` → portrait (neutral light, face large, 9:16).
  - `keyframeShot(shot, script, portrait, prev?, { image })` → keyframe with refs `[portrait, prev keyframe?]`.
    Prompt builder `keyframePrompt(shot, script)` (pure, tested): character look + setting + camera + emotion +
    "photoreal, cinematic, vertical 9:16, face clearly visible, mouth closed or neutral, no text, no watermark".
  - `clipShot(shot, keyframe, voice, { video })` → `seconds = snapDuration(voice.speechEnd + 0.4, capabilities.durations)`
    (pure, tested), motion prompt tells the model the person is *about to speak / speaking* and to keep the face
    toward camera.
  - `syncShot(clip, voice, { lipsync })` → lip-synced clip. Two modes, set by `--mode` / `SYNC_MODE`:
    - `lipsync` (default): any video model → lip-sync model with our audio.
    - `talking`: audio-driven avatar model (`TalkingProvider`) straight from the keyframe + audio, skipping i2v.
    - `native` is *not* implemented in this feature (needs the ASR gate on video audio — see F09 bench).
- `src/providers/fal.ts` — generic fal adapter on `@fal-ai/client` (`subscribe`, upload refs with `storage.upload`,
  download result to `out`). Key `FAL_KEY`.
- `src/providers/fal-models.ts` — registry: `{ id, kind: "image"|"video"|"lipsync"|"talking", endpoint,
  buildInput(args), pickOutputUrl(res), durations?, usdPerSecond|usdPerImage, verified: boolean, docsUrl }`.
  Seed it from `docs/research/video-models.md` and `voice-lipsync-asr.md`. For each entry fetch the model's fal page
  / `llms.txt` and set `verified: true` only if you confirmed the input field names there. Defaults via env:
  `IMAGE_MODEL`, `VIDEO_MODEL`, `LIPSYNC_MODEL`, `TALKING_MODEL`.
- `tests/visuals.test.ts`.

## Acceptance
1. `snapDuration(6.2, [5, 10]) === 10`, `snapDuration(4.1, [5, 10]) === 5`; above max → throws (script must be shorter).
2. Keyframe for s2 receives the portrait and s1's keyframe as refs (asserted on the mock call log).
3. Mock path for both modes yields a 1080×1920 clip with audio whose transcript sidecar equals the line.
4. Every registry entry has a `buildInput` unit test against its documented field names and a cost.
5. Nothing in this feature calls the network in tests.
6. `pnpm verify` green.

## Decisions
_(implementer fills in — list each fal endpoint, docs URL, verified yes/no)_
