# F14 — The clip judge watches the video, not 3 frames

## Goal
The clip judge sees 3 still frames (start, middle, end). Live on 2026-10-19 it could not tell a planned tilt-up that
leaves the character out of frame from a vanishing figure, and it missed that she walked away from the gate instead
of toward it (`docs/ai-log.md`, judge v6). Gemini accepts video natively. Send the clip itself, so the judge sees
motion, direction and continuity.

## Scope
- `JudgeVideoRequest` gets `video?: string` (path to the mp4). Frames stay the fallback.
- `GeminiJudge.judgeVideo`:
  - When `video` is set and the file is ≤ 18 MB (keep inline requests under Gemini's ~20 MB limit), send one
    `inlineData` part, `mimeType: "video/mp4"`.
  - Set `videoMetadata.fps` to 4, so a 4–15 s clip is sampled densely enough to see a camera move. Check the field
    name and its limits against the current @google/genai types and the Gemini video-understanding docs, and record
    the source and date in the spec's Decisions section.
  - Otherwise, or when the request fails because of the video part (a 400 that names it), fall back to the frames
    path and record why in the verdict notes.
- `estimateUsd` accounts for video: about 258 tokens per sampled frame plus 32 tokens per second of audio, at the
  chosen fps. Document the source in Decisions.
- Rubric (`src/prompts/judge.ts`, bump to judge-v7):
  - When a video is sent, say "Watch this vertical video clip" instead of "these frames".
  - Keep the v6 rules: a planned camera move may take the character out of frame, and the action must match the
    shot (direction of movement, who does what).
  - Add: the judge may hear the audio, but speech is checked elsewhere, so it must not score the words.
- `judgedTalkingShot` passes the clip path as `video`, and still extracts frames for the fallback. The content key of
  the cached verdict includes the clip file and the judge prompt version.
- `MockJudge` accepts `video` and records it in `calls`. The mock e2e stays green.
- `OpenRouter` is not involved; images and keyframes are unchanged.

## Acceptance
1. `tests/judge.test.ts`:
   - A Gemini judge with a fake client receives exactly one `video/mp4` inline part with `videoMetadata.fps === 4`,
     and no frame images, when `video` is given.
   - A video over 18 MB (stub the size check), or a fake 400 naming the video part, falls back to frames, and the
     verdict notes say why.
   - The v7 rubric says "Watch this vertical video clip", keeps both v6 rules, and tells the judge not to score
     the words.
2. `judgedTalkingShot` calls the judge with `video` equal to the clip path; the mock judge's calls show it.
3. `pnpm verify` green; F01–F13 tests still pass (update only the pinned judge version and wording).

## Decisions
- **Field name and limits (checked 2026-10-19).** `@google/genai` 2.30.0 (installed), `dist/genai.d.ts`:
  `Part.videoMetadata?: VideoMetadata` with `fps?: number`, "default 1.0, valid range (0.0, 24.0]", and "should only
  be specified while the video data is presented in inline_data or file_data". So the clip part is
  `{ inlineData: { mimeType: "video/mp4", data }, videoMetadata: { fps: 4 } }` (`JUDGE_VIDEO_FPS`). The current
  docs page (https://ai.google.dev/gemini-api/docs/video-understanding) shows the custom frame rate as
  `processing: { type: "static", fps }`. That shape belongs to the SDK's Interactions-API `VideoContent` type, not to
  `generateContent` parts, which is the API this repo calls, so I didn't use it. If a live run gets a 400 naming
  `video_metadata`, the frames fallback catches it and the reason is in the verdict notes.
- **Inline cap.** The same page says inline data suits "videos under 20MB total request size" (its table says
  < 100 MB). I used the spec's 18 MB on the raw file (`MAX_INLINE_VIDEO_BYTES`). Base64 adds ~33 %, so a file near
  18 MB could still go over 20 MB on the wire. In that case Gemini's 400 names the inline data and the fallback
  catches it. Our clips are 4–15 s at a few MB, far under the cap.
- **Fallback.** Frames are used when the file is over the cap, or when the request fails with a 400 whose message
  matches `video|inline_?data|mime`. Any other 400 (bad key, bad schema) still throws, so a real bug isn't hidden.
  The note reads `video … MB is over the 18 MB inline limit; judged 3 frames instead` or
  `video rejected (400): <message>; judged 3 frames instead`, and goes into the attempt's reason. The file size is
  read through an injectable `fileSize` (constructor option, tests only), so the oversized case needs no 19 MB fixture.
- **Cost.** The same docs page gives 258 tokens per frame (66 at low media resolution) and 32 tokens per second of
  audio. `estimateUsd({ images, rubric, videoSeconds })` adds `ceil(s·4)·258 + ceil(s)·32`. `JudgeVideoRequest`
  gets `seconds?` (the clip length) so the budget guard can price a video request. `judgeVideoEstimate` in
  `budget.ts` and `regenEstimateUsd` reserve the larger of the video and frames estimates, because the frames
  fallback could be the call that runs. A 6 s clip is ~6.4 k tokens of video against ~4.8 k for 3 frames.
- **Rubric.** `clipRubric(shot, script, { video: true })` opens with "Watch this vertical video clip" and ends with
  the audio note: the judge may hear the audio, but speech is checked elsewhere, so it must not score the words.
  Both v6 rules (a planned camera move may take the character out of frame; the action must match the shot) appear
  in both variants. `judgedTalkingShot` always uses the video variant. When Gemini falls back, the frames get the
  same rubric, with a "3 frames sampled evenly…" label in front of them, which is enough context. The bench
  (`src/bench/run.ts`) still sends frames only, so it keeps the frames wording (the default). `judge-v7`.
- **Cache key.** When a clip is sent as video, its bytes (`{ file: clip }`) and a `"video"` marker join the
  verdict key, alongside `JUDGE_PROMPT_VERSION`. The clip's content-addressed name (`subject`) stays in the key
  too: mock takes 1 and 2 have identical bytes but differ by prompt, and dropping `subject` made take 2 reuse
  take 1's verdict (test 3b caught it).
- **Rejected.** The Files API upload (resumable upload plus polling, more moving parts, needed only above ~20 MB).
  Rejected because our clips are small. A higher fps (8–24) would cost 2–6× the tokens for little gain on 4–15 s
  clips.
- No new dependencies.
