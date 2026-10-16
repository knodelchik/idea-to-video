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
- **Contracts first.** `schemas.ts` has the following new fields, all optional, so old manifests still parse:
  - `JudgeVerdict { score: int 1–10, issues: string[] }`;
  - `Attempt.score` (1–10, on `stage: "judge"` attempts);
  - `ShotOutput.keyframeScore`, `clipScore` and `needsReview`.
- **A bad judge reply is an error that carries its cost.** The shared `parseVerdict` throws
  `JudgeOutputError { costUsd, raw }` and both the mock and live judges use it. `judge()` in `src/nodes/quality.ts`
  catches *any* judge error (bad shape, HTTP, budget) and records an `ok:false` judge attempt with no score.
  - Such a take is *unscored*. It never passes, so it triggers a redraw or regeneration like a low score does.
  - `Budget.guard` also books the cost an error carries, so a paid-but-invalid reply counts toward MAX_COST_USD.
  - Rejected alternative: an `LlmResult`-style `{ok:false}` union. It adds a second failure channel next to thrown
    errors, and the spec's return shape is the plain verdict.
- **Where the loops live.** A new `src/nodes/quality.ts` holds `judgedKeyframe` and `judgedTalkingShot`.
  `visuals.ts` is already ~390 lines and stays judge-free. It gained only:
  - `keyframeShot({ variant, issues })`;
  - `talkingShot({ take, issues })`. Take k numbers its video calls after take k−1's, so variants and cache keys
    never collide.
  Without issues and variant, prompts and content keys are byte-identical to F05, so existing caches still hit.
- **Picking the take to keep.** The first take that passes wins. Otherwise the highest score wins (the earlier
  take on ties), and if nothing was scored, the first take. When nothing passed, the kept take gets
  `needsReview: true` and an explaining attempt.
  - The shot's `needsReview` is `keyframe.needsReview || clip.needsReview`.
  - A failing second clip take (ShotError / VerbatimError) never loses take 1: take 1 already passed the verbatim
    gate. Its attempts are recorded.
- **Budget check for the clip regeneration.**
  - `Budget.allows(usd)` uses the same arithmetic as `guard` but makes no call.
  - The node asks with the regeneration's *worst case*: `maxNative` video tries + lip-sync + judge, from
    `regenEstimateUsd`. A regeneration that might be cut off midway is therefore never started.
  - `withBudget` now passes `estimateUsd` through for video, lipsync and judge, so the node can price a take.
  - A skip is recorded as `stage:"regen", provider:"budget", ok:false`.
- **Verdict cache (rule 5).** `runs/<id>/judge-<kind>-<shot>-<key>.json` is keyed by:
  - the judge's name, `JUDGE_PROMPT_VERSION`, the rubric and the judged/ref file bytes;
  - for clips, also the clip's content-addressed file name. Mock takes are byte-identical, and the frames-only key
    made take 2 reuse take 1's verdict. A test caught this.
  Failed judge calls are not cached. The cache is re-parsed through `JudgeVerdict` on read.
- **Frames.** `src/media/frames.ts`: `frameTimes(s, n)` takes the centres of n equal slices, never t=0 or the last
  instant. `frameArgs` produces `-ss` before `-i` (fast seek), 1 JPEG frame, `-q:v 3`. Frames are
  content-addressed by the clip's bytes.
- **Live judge** `GeminiJudge`:
  - `generateContent` with `contents: [{role:"user", parts:[rubric, label, inlineData…]}]`,
    `responseJsonSchema = toGeminiSchema(JudgeVerdict)` and `temperature: 0`;
  - `JUDGE_MODELS` chain (default `gemini-3.8-flash,gemini-2.5-flash`); 429/503 → next model, noted;
  - cost from `usageMetadata` at `GEMINI_PRICES`;
  - estimate: 1600 tokens per image plus 4k output tokens, at the dearest model in the chain.
  The request shape is checked only against the SDK's `Part` type and a fake client. No live call was made (rule 1).
- **Settings.** `KEYFRAME_MIN` (default 7) and `CLIP_MIN` (default 5) come from env (`qualityFromEnv`, values 1–10
  or a loud error), via `PipelineDeps.quality`. `estimateRunUsd` now includes 4 judge calls.
  `createProviders("live")` needs `GEMINI_API_KEY` for `judge`.
- **Test edits outside `tests/judge.test.ts`.** Each adds the new `judge` capability; none weakens an assert.
  - `providers.mock.test.ts`: the capability list gains `"judge"`.
  - `graph.test.ts` test 5: the "every capability overridden" set gains `judge`.
- **New dependencies:** none.
- **Docs checked (2026-10-16):**
  - https://ai.google.dev/gemini-api/docs/tokens: 258 tokens per image ≤384 px, otherwise 258 per 768×768 tile.
  - https://ai.google.dev/gemini-api/docs/image-understanding: inline images, 20 MB request cap. Its JS sample now
    uses the Interactions API; we stay on `generateContent` like `GeminiLlm`, whose inline `Part` the SDK types.
