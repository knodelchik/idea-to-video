# F18 — Blocking and continuity: the script says where everyone is, where they move, and how shots connect

## Goal
In live runs the video was correct word for word, but it was hard to read as a story:
- **Castle (2026-10-19):** the script said she "advances toward the gate", and Seedance had her walk *away* from it,
  toward the camera. In the next shot she is inside.
- **Train (2026-10-19, run 20261019-121918-6f4903), three problems:**
  - She "runs toward the last train", but runs along the carriages toward the camera; the door she wants is never
    seen.
  - The run is in slow motion.
  - The conductor's line continues over a reaction cut to her, and her lips move. His voice seems to come from her
    face, which the author read as a face swap.

The judge scored these clips 10/10: nothing in its rubric asks about direction, pace or who is speaking.

The cause is the same in each case. The script describes **what** happens, not **how it is staged in the frame**.
Film calls this *blocking* and *continuity*. Make both explicit, checked fields of the script, write them into the
video prompts, and check them in a cheap critic pass and in the judge.

## Scope
### Contract (`src/schemas.ts`)
Add a `blocking` object to `Shot` and to every `Cut`. It is required for new scripts and migrated with sensible
defaults for old ones:
- `subjects`: one entry per on-screen character:
  - `{ name, position: "foreground"|"midground"|"background", side: "left"|"center"|"right",
    facing: "camera"|"away"|"left"|"right" }`.
- `movement`:
  - `{ who, direction: "toward camera"|"away from camera"|"left to right"|"right to left"|"none",
    target?: string, targetPosition?: same as position + side, pace: "real-time"|"slow-motion" }`.
  - `target` is a thing visible in frame ("the open door of the carriage"). When there is a target, its position
    must be set.
- `speaking`: the name of the one person whose lips move in this shot or cut, or null. Everyone else is silent with
  closed lips.
- `continuity` (on `Shot` only):
  - `{ from: string, screenDirection: "left to right"|"right to left"|"neutral" }`;
  - `from` is one sentence on how this shot follows the last moment of the previous one, e.g. "she reached the gate
    at the end of s1; now she is inside the hall";
  - `"start"` for s1.

Code checks (`scriptProblems`, fed back to the writer like the duration check):
- Every on-screen name has a subject entry. `movement.who` is on screen.
- `pace` is `"slow-motion"` only if the idea asks for slow motion (keywords: slow motion, slow-mo, slowly in slow
  motion).
- **Speaking:**
  - in a spoken shot the speaker is `speaking` in the cut that holds the line;
  - a cut whose `speaking` is someone else, or null, may only come after the line has ended;
  - so a reaction cut gets either no line over it, or `speaking: null` with the line already finished.
  - Rule: "a line is never heard over a cut where another character's face is on screen, unless that character
    is shown from behind".
- **Screen direction:** consecutive shots keep the same `screenDirection` unless `continuity.from` says the
  character turned (the 180° rule).

### Script prompt (`src/prompts/script.ts`, bump the version)
- First imagine the scene as a director: where the camera stands, where each person is, where they go, what they want
  to reach, and what the viewer must see to understand it. **The goal of a movement must be visible in the frame.**
- Then write `blocking` and `continuity` for each shot.
- **Movement:** describe it relative to the camera and to the goal ("runs from the foreground toward the open
  carriage door in the background, right"), never just "runs toward the train".
- **Pace:** real-time unless the idea asks otherwise.
- **Reaction shots:** only after the speaker finishes, and the listener stays silent with closed lips.
- **Continuity:** the end of shot N leads physically into shot N+1. For example, if she enters the castle next, in
  this shot she moves **toward** its gate, and the gate is in frame.

### Continuity critic (`src/nodes/script.ts`, new step after the code checks pass)
- One cheap LLM call (the same Gemini Flash; mock in tests) reads the whole script plus the idea. It answers in JSON
  `{ ok, problems: string[] }` for:
  - contradictions between shots (moves away from a place the next shot is inside);
  - a goal not visible;
  - a line over another person's face;
  - pace that does not fit the action;
  - a confusing first shot (would a viewer understand who, where and what in 2 seconds?).
- When problems are found, the writer gets them and rewrites. This shares the writer's retry budget (max 3 in total).
  If the critic still objects on the last try, keep the script and record the problems with `needsReview`.
- Record the critic as an Attempt (`stage: "continuity"`) and in the trace (an `evaluator` span in Langfuse, F17
  naming: `check-continuity`).

### Video prompt (`src/prompts/visuals.ts`, bump the version)
- Render blocking as plain staging sentences, after the shot size and the camera move. For example: "Olena in the
  foreground left, facing away, runs in real time toward the open carriage door in the background right."
- **For cut shots:** the same, per cut, plus "Only <speaking> speaks; <others> stay silent with closed lips."
- **For every shot:** "Real-time speed, natural pace, no slow motion." The only exception is a requested slow-motion.
- The keyframe prompt uses the first subject positions so the opening frame already shows the goal.

### Judge (`src/prompts/judge.ts`, bump to judge-v8)
- **Keyframe:** subjects roughly where blocking puts them, and the movement target visible.
- **Clip:**
  - the movement direction matches `movement` (toward/away/left-right), and the target is visible;
  - pace is real-time unless slow-motion was asked for;
  - only `speaking` moves their lips;
  - in cut shots, the rubric lists who is in each cut (fixing the 1/10 "identity changed" on a planned reaction cut).

### Mocks
- The mock script writer fills `blocking` deterministically: subjects center/midground facing the camera, pace
  real-time, speaking = speaker.
- The mock critic returns ok unless a test injects problems.

## Acceptance
1. **Contract and checks:**
   - a shot without blocking fails;
   - a target without a position fails;
   - slow-motion without the idea asking fails;
   - a line over a cut where another named character speaks or faces the camera fails;
   - opposite `screenDirection` in consecutive shots without a turn mentioned fails;
   - old scripts migrate.
2. **Prompt tests:**
   - the video prompt contains the staging sentence with direction, target and position;
   - "no slow motion" appears;
   - for cut shots, "Only X speaks; Y stays silent with closed lips";
   - the keyframe prompt names the target;
   - the judge v8 rubric names each cut's people, the direction and the lips rule.
3. **Critic:**
   - a fake critic that objects once leads to a rewrite, and a second fake verdict ok passes;
   - a critic that always objects ends with the script kept, a `continuity` Attempt with the problems, and
     `needsReview`;
   - the critic's cost is in the manifest.
4. `npx tsx src/cli.ts '<the train storyboard idea from docs/ai-log.md>' --mock --json` → ok; every shot has blocking
   and continuity.
5. `pnpm verify` green; F01–F17 tests still pass.

## Decisions
- **Required vs migrated, by prompt version.** `Shot.blocking`, `Shot.continuity` and `Cut.blocking` are required in
  the schema, so `ScriptDraft` (what the writer must return) and `Shot` reject a shot without them. `Script`'s
  preprocess (`migrateBlocking`, after the F11 `migrateScript`) fills defaults only when `promptVersion` is not
  `script-v<n>` with n ≥ 8 (`predatesBlocking`). So a script-v8 script without blocking fails, while old manifests,
  bench/preflight scripts and hand-built test scripts still parse. Defaults: every on-screen name center/midground facing
  the camera, `movement: null`, `speaking` = the speaker when on screen, `continuity` `"start"` / `"follows the previous
  shot"`, `neutral`. Rejected: an optional `blocking` field (then "a shot without blocking fails" would be untrue), and
  migrating every script without blocking (then a new script could skip it).
- **`movement` is nullable.** `null` means nobody moves (a held moment, an insert with nobody on screen). The spec's
  shape needs a `who`, which an insert doesn't have. The "target needs a position" rule is a zod `refine` on `Movement`,
  so it fails at the boundary, not only in `scriptProblems`.
- **Checks live in `src/blocking.ts`** (pure, like `speakers.ts` / `storyboard.ts`). `scriptProblems` calls
  `blockingProblems`. They are not in the schema's `superRefine`, because migrated old scripts (e.g. F13 reaction
  cuts while the line continues) would then stop parsing. The checks:
  - subjects match `onScreen` one to one; `movement.who` and `speaking` are on screen;
  - `slow-motion` only if the idea matches `/\bslow[\s-]?mo(tion)?\b/i`;
  - speaking: the shot's `speaking` is the speaker, or null for a silent shot; at least one cut holds the line; no other
    name speaks; a cut with people where the speaker is not `speaking` may not come before a cut that holds the line;
    in a line-holding cut, every other subject must face `"away"`. Facing left or right is a profile, which is still a
    face, so it fails. The spec allows only "shown from behind".
  - s1 `from` is `"start"`, later shots are not; opposite non-neutral `screenDirection` in consecutive shots fails
    unless `from` mentions a turn (`turn/turns/turned/turning/spins/wheels around/reverses/doubles back/comes back`).
- **Inserts may carry the line.** A cut with nobody on screen shows no face, so it is not a "reaction cut". It may sit
  between line-holding cuts, and the video prompt says "the line continues over the insert in shot N". The F13
  speaker → insert pattern still works. Reaction cuts with people get "the line is spoken in shot 1 and has ended
  before shot 2" instead of the old "continues over the cuts".
- **Critic = same `LlmProvider`, marked `purpose: "continuity"`.** I added an optional `purpose` to `LlmRequest`. It does
  three things:
  - `withTrace` records it, and the Langfuse plan maps such an `llm` span to `check-continuity`, type `evaluator` (F17
    naming, added to `OBSERVATION_NAMES`);
  - `MockLlm` answers critic calls from a separate `critic` queue that defaults to `MOCK_CRITIC_OK` and logs them in
    `criticCalls`. Existing writer queues and `calls` counts stay as they were, and tests inject objections with
    `new MockLlm({ critic: [...] })` (plus `criticCost` to price them);
  - `GeminiLlm` ignores it, so the live critic is the same Flash chain as the writer.

  Rejected: a separate `critic` provider in `Providers` (one more live key/config for the same model) and detecting the
  critic by its system prompt in the mock (brittle).
- **Retry budget.** The critic runs only after the code checks and `Script.parse` pass. Each objection becomes a
  `continuity: <problem>` line in the writer's retry prompt and uses one of the 3 writer attempts. On the last attempt the
  script is kept with `needsReview: true` and `reviewNotes`, both new optional `Script` fields that are not in
  `ScriptDraft`. The critic is advisory, so it can never turn a passing run into a failing one. `writeScript` remembers
  the last script that passed the code checks but drew an objection. If the rewrites the critic asked for then fail the
  code checks (a paraphrased line, a wrong duration), that remembered script is returned with `needsReview` and its
  critic problems in `reviewNotes`, and no `ScriptError` is thrown. Rejected: throwing after the last attempt. That was
  the first version, and the review rejected it because a script that passed before F18 would now fail. A critic verdict of `ok: true` that still lists problems counts as an objection: code trusts the list.
  So does `ok: false` with no problems (recorded as "objected without naming a problem"). A reply that fails the
  `ContinuityVerdict` schema keeps the script with `needsReview` and a failed `continuity` attempt. Rewriting because
  the critic's JSON was bad would waste writer calls, and it is not a silent pass. A critic call that *throws* (all
  Gemini models 503, another API error, a `BudgetExceededError` from `withBudget`) is handled the same way: the error is
  caught in `checkContinuity`, the script is kept with `needsReview`, and a failed `continuity` attempt says
  `continuity critic call failed: <message>`, so the writer's attempts and cost stay in the manifest. Budget refusals are
  not rethrown: the refused call sent nothing, and the next paid stage meets the same cap and stops the run there, with
  the script stage already finished (a resume does not rewrite it). Rejected: letting the error escape (the third review
  showed the run failing with one $0 `pipeline` attempt and the writer's spend lost), and rethrowing budget errors with
  the attempts attached (one more error path for a stop that happens one stage later anyway). The critic's cost is on its Attempt,
  so the manifest's `costUsd` includes it. Script `needsReview` also feeds the Langfuse `needs_review` score and the
  metrics `needsReviewRate`.
- **Prompts.**
  - `script-v8`: a director-first section, the blocking/continuity schema in words, movement relative to camera and goal,
    real-time pace, reaction shots only after the line.
  - `visuals-v7`: staging sentences after size and camera move. Cut shots get per-cut staging plus "Only X speaks; Y stays
    silent with closed lips." Every shot gets "Real-time speed, natural pace, no slow motion." (or a slow-motion line
    when the blocking asks). The keyframe gets "Staging: … ; <target> visible in <place>". When the blocking turns the
    speaker away, "looks toward the camera" is dropped.
  - `judge-v8`: keyframe item 7 for staging and the visible goal; clip items for direction + target, pace and lips (per
    cut); the cuts note lists each cut's people.

  Shared phrasing is in `src/prompts/staging.ts`, so the prompt and the rubric describe the same staging. `visuals.ts`
  imports `judge.ts`, so putting the helpers in either file would create an import cycle.
- **Critic prompt** is `src/prompts/continuity.ts` (`continuity-v1`). It sends the idea, the setting and the
  staging-relevant shot fields (not looks or voices).
- **Mock writer**: one subject center/midground facing the camera, `movement { who, direction: "none", pace:
  "real-time" }`, `speaking` = speaker on spoken shots and cuts, `continuity` `"start"` / `"follows straight on from the
  last moment of s<n>"`, `neutral`.
- No new dependencies. zod 4 `refine`/`nullable` and `z.toJSONSchema` were already used in the repo. The live JSON
  schema now has nullable fields: `speaking` becomes `"type": ["string", "null"]` and `movement` becomes
  `anyOf: [object, {type: "null"}]`. Checked https://ai.google.dev/gemini-api/docs/structured-output (2026-10-19):
  - "To allow a property to be null, include "null" in the type array", and `null` is a supported type;
  - `anyOf` appears in the page's own example, and `toGeminiSchema`'s allow-list already keeps it.

  Not yet seen live: if Gemini rejects the `anyOf`, the fallback is a non-null movement with `direction: "none"`.
