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
