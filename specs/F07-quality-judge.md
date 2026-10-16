# F07 — Quality judge and regeneration

## Goal
Catch bad generations before they reach the edit, and measure quality so changes can be compared. Judge what a
VLM can judge; never ask it what code can compute (duration, words).

## Scope
- `src/providers/types.ts` — `JudgeProvider.judgeImage({ path, rubric, refs? })` and `judgeVideo({ frames[], rubric, refs? })`
  → `{ score 1–10, issues: string[], costUsd }` (Zod-validated).
- `src/providers/gemini-judge.ts` — live judge (Gemini vision, structured output, model chain `JUDGE_MODELS`).
  `src/providers/mock.ts` — mock judge with scripted scores.
- `src/prompts/judge.ts` — `JUDGE_PROMPT_VERSION`, rubrics:
  - keyframe: anatomy/hands, face large and sharp enough for lip-sync, matches `shot.visual` and `character.look`,
    no text/watermark, vertical composition;
  - clip (3 sampled frames + portrait as ref): same person as portrait, no warping/morphing, mouth region intact,
    motion plausible.
- Wire into F05/F06 nodes: keyframe score < `KEYFRAME_MIN` (default 7) → regenerate with the issues appended to the
  prompt, max 2 extra (free/cheap images). Clip score < `CLIP_MIN` (default 5) → one regeneration only if the budget
  guard allows. Best attempt wins if none pass; `needsReview: true` is set on that shot. Scores go to the manifest.
- `src/media/frames.ts` — extract N frames evenly (ffmpeg), pure args tested.
- `tests/judge.test.ts`.

## Acceptance
1. Scripted judge 4 → 8: keyframe regenerated once, issues text present in the second prompt, both scores recorded.
2. Always-low judge: at most 2 extra keyframes, best kept, `needsReview: true`.
3. Clip regeneration is skipped (and recorded) when the budget guard says no.
4. Judge output that fails the schema counts as a judge failure (recorded), not as a pass.
5. `pnpm verify` green.

## Decisions
_(implementer fills in)_
