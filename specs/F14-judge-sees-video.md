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
