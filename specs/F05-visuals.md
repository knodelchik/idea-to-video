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

**Contract.** `SHOT_SECONDS` is now 4–15 and the total stays 8–30. The script prompt reads both ranges from the
schema, so they can't drift; the prompt version is now `script-v2`.

**Node shape** (`src/nodes/visuals.ts`, prompts in `src/prompts/visuals.ts`):
- The spec's signatures gain the opts they need:
  - `dir` for content-addressed outputs;
  - `script` in `talkingShot` (needed by `talkingPrompt` and by `verifiedVoice` for the character);
  - optional `maxVoice`.
- `castCharacter` and `keyframeShot` return `{ path, attempts }`.
- `talkingShot` returns `{ path, seconds, hasAudio, via: silent|native|lipsync, verbatim, speechStart/End, attempts }`.
- **`seconds` and `hasAudio` are always measured with ffprobe on the returned file** (hard rule 4). This was added
  on attempt 2, after the reviewer rejected attempt 1.
  - `SeedanceVideo` probes the downloaded clip. Its `probe` is injectable, because the tests' fake bytes aren't an mp4.
  - The node probes every clip itself and ignores the adapter's `seconds`/`hasAudio`. A lip-synced shot reports the
    *synced* file's length, since a lip-sync model may trim (Kling caps input at 10 s).
  - Only `costUsd` comes from the adapter, because it is what the provider bills (on the requested duration).
  - `TalkingShotOpts.probe` defaults to ffprobe and is injectable so a test can see what was measured.
  - Rejected: trusting the adapter and probing only cached clips (the attempt-1 code). It hides a clip that is short
    or silent.
- Clip length is `snapDuration(shot.seconds, capabilities.durations)`. The F03 script check already makes sure the
  line fits in `shot.seconds`.
- Variants: native retry *n* uses `variant = n-1`. Lip-sync goes onto the native clip with the lowest WER.
- A video model with `nativeSpeech: false` makes one base clip and goes straight to the fallback. This is recorded
  as an attempt with its reason.
- A provider error is recorded as a failed attempt and thrown as `ShotError { shotId, attempts, cause }`.
  - `PolicyRejectedError` is never retried, because the same keyframe would be rejected again. It is not
    lip-sync-fallback-able either, since there is no clip to sync onto. The message names the provider, says
    "rejected by content policy (…); not retried" and suggests changing the keyframe or prompt.
  - Other video errors are also not retried here. Transport retries are the adapter's job.
- A lip-synced clip that still fails the gate throws `VerbatimError` (stage `lipsync s1`) with the full attempt story.
- Delivery tags (`[whispers]`) are taken out of the quoted line in `talkingPrompt` and added to the emotion.
  - Rejected: quoting the raw line with the tags in it. Seedance would likely speak the tag.
- Every artifact key includes `VISUALS_PROMPT_VERSION`, the provider name and the input *file contents*. A resumed
  run makes zero image or video calls (tested).
- Rejected: one generic `generateShot` doing keyframe + video together. Separate steps let F06 checkpoint and
  resume between them.

**Errors.**
- `src/providers/errors.ts` holds `PolicyRejectedError` (new). `NotConfiguredError` moved here from `index.ts`
  (still re-exported there), so the adapters' `*FromEnv` can throw it.
- `createProviders("live")` now builds image, video and lipsync from env. `talking` still has no live adapter
  (not in scope), so a live run still needs a `talking` override until a later feature adds one.

**Mocks.**
- `MockImage`, `MockVideo`, `MockTts` and `MockLipsync` gain a `calls[]` log.
- `VideoFault` gains `reject` (it throws `PolicyRejectedError`), and its `say` field is now optional.
- `MockVideo` now also checks that the keyframe file exists.

**Seedance 2.0, fal transport.** Verified on 2026-10-16 against
https://fal.ai/models/bytedance/seedance-2.0/image-to-video/llms.txt and
https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video/llms.txt.
- Endpoints are `bytedance/seedance-2.0/image-to-video` and `.../fast/image-to-video` (`SEEDANCE_TIER=fast`).
- Input:
  - `prompt` and `image_url`;
  - `duration` as a **string** enum `"4".."15"` (or `"auto"`);
  - `aspect_ratio: "9:16"`, `resolution: "720p"`, `generate_audio: true`.
- Output is `video.url`.
- **There is no `seed` input**, so a retry relies on sampling variety.
- Price at 720p: $0.3034/s standard, $0.2419/s fast.
- Errors (https://fal.ai/docs/model-apis/errors, and `ApiError`/`ValidationError` in the installed
  `@fal-ai/client@1.10.1` `response.d.ts`):
  - a policy block is a 422 with `detail[].type === "content_policy_violation"`, mapped to `PolicyRejectedError`;
  - everything else is rethrown unchanged.
- The client calls `createFalClient({ credentials })`, `subscribe(endpoint, { input })` → `{ data, requestId }` and
  `storage.upload(Blob)`. All three were checked against the installed type definitions (the docs page doesn't cover
  `storage`).
- `@fal-ai/client` was already in package.json, so no new dependency.

**Seedance 2.0, BytePlus transport: UNVERIFIED.** docs.byteplus.com renders client-side and returned only
navigation. The shape comes from https://www.datacamp.com/tutorial/seedance-2-0-api-guide plus search snippets, and
the code is marked UNVERIFIED.
- Base `https://ark.ap-southeast.bytepluses.com/api/v3` (`ARK_BASE_URL` overrides).
- `POST /contents/generations/tasks` with:
  - `model` (`SEEDANCE_MODEL`, default `dreamina-seedance-2-0-260128`);
  - `content: [{type:"text"}, {type:"image_url", image_url:{url}, role:"first_frame"}]`;
  - top-level `ratio`, `duration` (int), `resolution`, `generate_audio`, `watermark: false`.
- Then `GET /contents/generations/tasks/{id}` until `succeeded` (→ `content.video_url`) or
  `failed`/`cancelled`/`expired`. Polls every 5 s with a 15 min timeout.
- Unconfirmed: inline base64 data URLs for the image; the error codes. Policy is detected by the text
  (`sensitive|real person|content policy|risk control`), on a 4xx or on a failed task. The one confirmed message is
  "the input image may contain a real person".
- Price: an estimate of $0.15/s at 720p (docs/research/video-models.md), not per-token.
- Pages a human should check before the first live run:
  - https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api
  - https://docs.byteplus.com/en/docs/modelark/seedance-2-0
  - https://docs.byteplus.com/en/docs/modelark/model-pricing

**Image** (`IMAGE_PROVIDER`, default `fal-nano-banana`):
- `fal-nano-banana`: verified at https://fal.ai/models/fal-ai/nano-banana/edit/llms.txt.
  - With refs it calls `fal-ai/nano-banana/edit` with `{prompt, image_urls[], aspect_ratio:"9:16", num_images:1,
    output_format:"png", seed?}`. Without refs it calls `fal-ai/nano-banana` with the same fields minus
    `image_urls`; that endpoint's field set is inferred from the edit page.
  - Output is `images[0].url`. $0.039 per image.
- `gemini`: request shape verified at https://ai.google.dev/gemini-api/docs/image-generation.
  - It uses the Interactions API, not `generateContent`: `POST /v1beta/interactions`, `input[{type:"user_input",
    content:[text, {type:"image", mime_type, data}]}]`, `response_format:{type:"image", aspect_ratio:"9:16",
    image_size:"1K"}`.
  - The response wrapper is unverified and parsed leniently.
  - Default model `gemini-nano-banana-2.1` (`gemini-2.5-flash-image` shut down on 2026-10-02). $0.0336 per 1K image
    (https://ai.google.dev/gemini-api/docs/pricing).
- `seedream`: **UNVERIFIED** (BytePlus docs didn't render).
  - `POST {ark}/images/generations` with `{model (SEEDREAM_MODEL, default seedream-5-0-260128), prompt, image[] data
    URLs, size "1440x2560" (SEEDREAM_SIZE), response_format "b64_json", watermark false}` → `data[0].b64_json|url`.
  - About $0.035 per image (fal's Seedream Lite price, used as an estimate).
- Images are written to `out` as returned. MIME is sniffed from magic bytes when sending refs, never taken from the
  extension.

**Lip-sync** (`LIPSYNC_PROVIDER`, default `fal-kling`):
- `fal-kling`: verified at https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video/llms.txt.
  - `{video_url, audio_url}` → `video.url`.
  - $0.014 per input-video second, rounded up to 5 s; cost uses ffprobe on the clip.
  - Documented limits: video 2–10 s, audio ≤ 5 MB. The adapter declares `maxSeconds = 10`, and `talkingShot` trims a
    longer clip before syncing (see *Lip-sync input limits* below).
- `command`: `LIPSYNC_CMD` with `{video} {audio} {out}`, split into argv with quote support and run through
  `execFile`.
  - No shell, so a path can't inject anything.
  - All three placeholders are checked at construction, and the output file must exist afterwards.

**Test fakes for fal storage** (attempt 3): the fake `storage.upload` returns `https://fal.media/up/<sha256 of the
uploaded bytes>`, not a counter. `FalNanoBananaImage` uploads refs in parallel (`Promise.all`), so a counter numbered
URLs by which upload finished first, and the exact `image_urls` check flaked (1 failure in 2 runs). Multi-upload tests
now pass byte-different files (`[kf2, kf]` for nano-banana, separate video/audio files for kling), so a reorder
bug would fail. Checked by mutation: reversing the refs in `image.ts` fails the nano-banana test. Rejected:
uploading sequentially in the adapter. The product code was right, and changing it to fit a fake would only slow
down live runs.

**Gate evidence for acceptance 8:** `scripts/harness.sh` `gate()` prints nothing when it passes, so a green
`harness/logs/F05-visuals-gate-N.txt` is always 1 byte (just a newline). I can't change that file, so the full
output is recorded in `harness/logs/F05-visuals-verify-evidence-3.txt` (`pnpm verify` → `VERIFY OK`, 156 tests) and
`harness/logs/F05-visuals-accept-evidence-3.txt` (the `accept` command, 32/32, verbose). `pnpm verify` was run 4 times
in a row on attempt 3, all green.

**Fallback failures keep the story** (after the BLOCKED notes):
- `talkingShot` is now a thin wrapper around `produceTalkingShot`, which shares its `attempts` array with the wrapper.
  Any error that isn't already a `ShotError` or `VerbatimError` (an ffprobe failure, a bug) is wrapped in a
  `ShotError` that has the attempts made so far. Both of those error types already carry the attempts.
- The steps that can fail are recorded explicitly, as a failed attempt with a reason, before they throw:
  - an ASR error on a native clip: a `video` attempt whose `costUsd` is the clip's, because the clip was paid for;
  - a `lipsync.sync` error: a `lipsync` attempt with `lip-sync error: …`;
  - an ASR error on the lip-synced clip: a `lipsync` attempt that includes the sync cost.
- Rejected: only the outer catch-all. It would keep the attempts, but the last step would have no record of its own
  failure or its cost.

**Lip-sync input limits** (after the BLOCKED notes):
- `LipsyncProvider.maxSeconds` is required:
  - Kling: 10 (fal page, "2–10 s");
  - `command`: `Infinity`, or `LIPSYNC_MAX_SECONDS`, which is validated as a positive number;
  - `MockLipsync({ maxSeconds })`: defaults to `Infinity`, and **rejects** a longer input the way the API would, so
    the trim test can't pass unless the node actually trims.
- When the best clip's measured length is over `maxSeconds`, the clip is trimmed to `voice.speechEnd + 0.4` s
  (`LIPSYNC_TRIM_TAIL`). The trim uses `trimArgs`, a pure builder in `media/args.ts`: it re-encodes for a
  frame-exact cut and keeps the video only, since lip-sync replaces the audio anyway.
  - The trim is content-addressed (`trim-<shot>-<key>.mp4`) and recorded as a `trim` attempt, with before and after
    lengths.
  - If `speechEnd + 0.4` is still over the limit, a failed `trim` attempt is recorded and a `ShotError` names the
    provider, its limit and where the speech ends. Speech is never silently cut.
- `speechEnd` is relative to the voice file. That only holds because the voice is laid from t=0 of the clip, which
  is true of the mock and of Kling's audio-to-video.
- The synced shot can come out shorter than `shot.seconds`. That is expected: the node already reports the measured
  length, and F06 normalises clips to their slot.
- Rejected:
  - trimming to `maxSeconds`, which would keep more footage. The human note specified `speechEnd + 0.4`.
  - a `minSeconds` check (Kling's 2 s lower bound). The trim only runs on clips longer than `maxSeconds`, and a
    lip-synced line is always longer than 2 s in practice. A shorter one is left to the API error.

**Fal storage fakes:** content-derived URLs and byte-different ref files were already in place (attempt 3, above).

**Evidence, post-BLOCKED run:** `npx vitest run tests/visuals.test.ts` → 38/38. `pnpm verify` → `VERIFY OK`
(162 tests). The 6 new tests each failed for the expected reason before the code change.

**No new dependencies.**

**Silent native takes (rework, attempt 2):** `generate_audio` is a request, not a guarantee (`seedance.ts`). The node
already measured `hasAudio` with ffprobe but sent every native clip to ASR anyway. Live `GroqAsr` extracts
`-map 0:a:0` and throws on a file with no audio stream, so the shot died as "asr error" without a retry or the
fallback. Now a native clip with `!hasAudio` is recorded as a failed `video` attempt (`no audio track`, provider =
the video model, with the clip's cost). ASR is not called, and the loop moves on to the next take.
- The silent clip is kept as the lip-sync base only if no take had audio (`wer = Infinity`), because any take with
  audio beats it. Lip-sync replaces the audio, so a silent base is fine.
- If every take was silent, the fallback reason says so ("no take had an audio track") instead of printing
  `best wer Infinity`.
- Rejected: making `MockAsr` throw on silent files. ASR outages are already covered with `FlakyAsr`. A test-local
  `StrictAsr` that probes the file and throws on missing audio copies the live behaviour without changing the mock
  that every other test depends on.
- Tests: "a native clip without an audio track is a failed take" and "every native take silent → TTS + lip-sync
  fallback". Both failed with `ShotError: asr error on native clip` before the fix.

**Pre-flight audit of live adapters (2026-10-16, before the first paid run):**
- BytePlus Seedance request/poll shape checked against the official `byteplus-python-sdk-v2` 3.0.62
  (`content_generation/tasks.py`, `content_generation_task.py`): matches. Prices and model ids checked against
  https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1544106. Fixed: 720p price $0.15 → $0.1512/s
  ($7/M tokens × 720·1280·24/1024 tokens/s); added `SEEDANCE_TIER=fast` on BytePlus (`dreamina-seedance-2-0-fast-260128`,
  $5.6/M → $0.12096/s); reported cost now uses the task's `usage.completion_tokens` when present.
- Seedream default model `seedream-5-0-260128` does not exist on the pricing page → `seedream-5-0-lite-260128` ($0.035).
- fal Seedance (standard + fast), nano-banana, Kling lip-sync and Kling avatar inputs re-checked against their
  `llms.txt` pages: no change needed.
- Added `scripts/preflight.ts` (`pnpm preflight`, no network) and `scripts/smoke-free.ts` (`pnpm smoke:free --yes`,
  free-tier hosts only, guarded fetch). No new dependencies.

## Human notes after BLOCKED (2026-10-16)
The harness stopped after 3 rejected attempts; each review found a new real issue. Carry these over:
- Last open review issue: errors thrown by `lipsync.sync` and by the final `listen` in the fallback escape without
  `ShotError`, so the recorded attempts (failed native takes, the paid voice take) are lost. Wrap them; every
  failure path of `talkingShot` must return/throw with the full attempt list.
- Spec gap (mine): lip-sync providers have input limits (Kling lip-sync: video 2–10 s). Each `LipsyncProvider`
  declares `maxSeconds`; when the clip is longer, the fallback trims the clip to `voice.speechEnd + 0.4` s before
  syncing if that fits, otherwise fails with a recorded, readable reason (no silent truncation of speech).
- The fake fal `storage.upload` must return content-derived URLs; ref-order tests use two different files.
