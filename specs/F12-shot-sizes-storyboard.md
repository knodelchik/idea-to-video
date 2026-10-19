# F12 — Wide shots and storyboard ideas

## Goal
1. **Not only face close-ups.** Today every shot is a close-up: the script prompt demands "close framing that keeps
   the face large", `Shot.camera` allows only close-up / medium close-up / medium, the keyframe prompt demands "face
   clearly visible", and the judge marks a keyframe down when the face is too small for lip-sync. A reviewer who
   types "a small girl in front of a huge castle" gets a close-up of a face. HOLYWATER's My Muse publishes AI
   fantasy/romance micro-series (castles, ballrooms), so establishing shots matter.
2. **Storyboard ideas.** Let the idea be written shot by shot: `1 кадр: дівчина відчиняє двері у замок. 2 кадр:
   заходить у велику бальну залу, зала видна вся, а дівчина маленька на її фоні.` (or `Shot 1: … Shot 2: …`,
   `1. … 2. …`). Code, not the LLM, splits it, and the script must have exactly those shots in that order.

Research: `docs/research/seedance-playbook.md` and the notes below (Runway Seedance 2.0 guide 2026-09-24; Cutout.pro
Seedance audio guide 2026-04-08; vertical micro-drama guides). Key facts: use standard shot-size words; one camera move
per shot; wide shots make lip movement imprecise, so a line on a wide shot should be heard, not lip-read; in 9:16 a wide
shot needs a vertical reason (tall architecture, the character small in the lower third); identity at a distance comes
from 2–3 high-contrast features (hair colour, one bright outfit colour, a silhouette item).

## Scope
### Contract (`src/schemas.ts`, change first)
- `Shot.camera`: `"extreme wide shot" | "wide shot" | "full shot" | "medium shot" | "medium close-up" | "close-up"`.
  Old values still parse: `"medium"` → `"medium shot"` (migration, like F11's). Export `isWide(camera)` = extreme
  wide / wide / full.
- Up to **4** shots: ids `s1`…`s4` in order (Shot, Attempt.shotId, RunManifest.shots). Each 4–15 s, total 8–30 s as
  today. At least one shot has a line (the task needs a spoken line).
- `Character.look` must contain identity cues that read at a distance: the script prompt asks for them; no schema rule.

### Storyboard parsing (`src/storyboard.ts`, new, pure)
- `parseStoryboard(idea): { beats: string[] } | null`. Recognise numbered beats 1..N (N 2–4, consecutive from 1) with
  markers: `1 кадр`, `кадр 1`, `Кадр 1:`, `Shot 1`, `shot 1:`, `1.`, `1)`, at the start of the idea or of a
  line/sentence. Return null when fewer than 2 beats, numbers skip or repeat, or more than 4 (then: error "a storyboard
  has at most 4 shots" before any paid call). Must not fire on ordinary numbers ("at 3:15", "in 1987", "$4.50", "2
  coffees"), nor on numbers inside quoted lines.
- Text before beat 1 is shared context for all shots.
- Descriptions may be in any language (Ukrainian included). Only the quoted lines must be English (F10 guard unchanged);
  the script writer writes `visual` in English.

### Script (`src/prompts/script.ts` bump version; `src/nodes/script.ts` checks)
- With a storyboard: the user prompt lists the beats; `scriptProblems` rejects a script whose shot count ≠ beats, and a
  quoted line that sits in beat k must be in shot k's line (check by code).
- Without a storyboard the writer picks 1–4 shots (usually 2), still 8–30 s.
- Replace the close-framing rule with shot-size rules:
  - pick each shot's size from the enum; a two-shot beat with a strong place defaults to "wide/full shot to set the
    place, then a medium close-up for the key line"; never two close-ups in a row unless it is a dialogue;
  - a wide shot only when the place matters, composed vertically (tall architecture, the character small in the lower
    third);
  - a spoken line may sit on any size, but on extreme wide / wide / full the line is **heard** (the character is small,
    lips need not be readable); prefer putting the key line on a medium close-up when the storyboard leaves the choice;
  - `look`: 2–3 high-contrast features that read at a distance, repeated identically.
- No quoted line: still write one short line, attached to the most fitting shot.

### Visuals (`src/prompts/visuals.ts` bump version)
- Keyframe: wide sizes → "the character is small in frame, full figure visible, recognisable by <cues>; the place
  dominates" instead of "face clearly visible, mouth closed"; close sizes unchanged.
- Video prompt order: shot size, one camera move (wide: locked-off or slow crane/pull-back; close: slow push-in), subject
  with identity cues, action, audio. On a wide shot with a line: `<Name>, small in frame, says in English: {line}` —
  keep the F11 syntax, audio policy and constraint tail; drop "looks toward the camera".
- Portrait refs still used (identity); the real-face ladder is unchanged.

### Judge (`src/prompts/judge.ts`)
- Keyframe rubric item 2 by size: close sizes keep "face large enough for lip-sync"; wide sizes use "the character is
  recognisable by its look (hair, outfit, silhouette), anatomically whole, the setting matches and dominates".
- Clip rubric: on wide sizes skip the mouth-region item; check no duplicated or melting figures and stable architecture.

### Fallback on wide shots (`src/nodes/visuals.ts`)
- Lip-sync on a small face is pointless (and the fal Kling model needs a visible face). When native speech fails on a
  wide-size shot: verified TTS is laid over the clip **without** lip-sync (`via: "voiceover"`), recorded in the
  manifest with the reason. Close sizes keep TTS + lip-sync. The final gate is unchanged (ASR of the final file).

### Mocks, eval, CLI
- Mock script writer honours a storyboard (one shot per beat, wide sizes for beats that mention a hall/castle/
  street/landscape, etc. — keyword heuristic is fine for the mock) and up to 4 shots.
- Cost estimate and budget handle 4 shots.
- Add 3 ideas to `evals/hard.jsonl`: the castle storyboard (Ukrainian beats + English line), a 4-beat English
  storyboard, and a wide-shot idea without a storyboard ("a tiny figure on a cliff above a stormy sea shouts: …").

## Acceptance
1. `parseStoryboard` tests: the Ukrainian castle example → 2 beats; `Shot 1: … Shot 2: … Shot 3: …` → 3; `1. … 2. …`
   → 2; null for "At 3:15 a.m. in 1987 she buys 2 coffees for $4.50", for a single beat, for `1 … 3 …`, and for numbers
   inside a quoted line; 5 beats → error before any paid call.
2. Contract tests: all six sizes parse; `"medium"` migrates; 4 shots parse, 5 fail; ids must be s1..sN in order; a
   script with no line anywhere is rejected; old manifests still parse.
3. `npx tsx src/cli.ts '1 кадр: маленька дівчина в червоному плащі відчиняє величезні двері старого замку. 2 кадр: вона заходить у величезну бальну залу, зала видна вся, дівчина маленька на її фоні, і каже: "Hello? Is anyone still here?"' --mock --json`
   → ok, exactly 2 shots, shot 2 has the line and a wide size, the line verbatim in the final file.
4. A 3-beat English storyboard via CLI `--mock` → ok, 3 shots, total 8–30 s.
5. Prompt tests: wide keyframe prompt has no "face clearly visible" and names the identity cues; wide talking prompt has
   `small in frame, says in English: {…}` and no "looks toward the camera"; judge keyframe rubric for a wide shot has no
   lip-sync item.
6. Visuals test: native speech fails twice on a wide shot → TTS laid without a lip-sync call (`via: "voiceover"`,
   MockLipsync not called); on a close-up the old TTS + lip-sync path is unchanged.
7. `pnpm verify` green; F01–F11 tests still pass (update only where the contract changed; never weaken a verbatim
   assertion).

## Decisions
- **Contract.** `Shot.camera` uses the exported `Camera` schema:
  `z.preprocess(v => v === "medium" ? "medium shot" : v, z.enum(CAMERAS))`. The migration sits on the field, so a bare
  `Shot`, a `Script` and a `RunManifest` all accept old values. `z.toJSONSchema` (the Gemini response schema) takes the
  output side of the pipe, so the model sees the plain six-value enum. A test pins this.
  - `isWide()` is true for extreme wide, wide and full.
  - `MAX_SHOTS = 4` and `ShotId = s1..s4` live in `schemas.ts`, and every other module imports them from there.
    `nodes/script.ts` re-exports `MAX_SHOTS`.
  - `ShotOutput.audio` gains `"voiceover"`, and `TalkingShot.via` gains `"voiceover"`. The graph maps `lipsync` →
    `"fallback"` as before; every other value passes through unchanged.
  - Rejected: a wide-only flag on Shot. The size is already in the data, so a flag would duplicate it.
- **Storyboard parsing (`src/storyboard.ts`)** works in four steps:
  1. Masks quoted spans. `quoteSpans` blanks them, so a number inside a line never becomes a marker.
  2. Matches markers: `кадр N`, `N кадр`, `shot N` (any case), or `N.` / `N)` followed by whitespace.
  3. Keeps a marker only at a boundary in the *original* text: the start of the idea, a newline, or after
     `. ! ? … : ;` (optionally followed by a closing quote or bracket), or right after a closing quote.
  4. Accepts numbers only as consecutive 1..N with non-empty beats.

  It returns `{ context, beats, spans }`; `spans` lets `quoteBeats` place each quote in its beat. More than 4
  well-formed beats throw `StoryboardError`, which `preSpendProblems` turns into a $0 `IdeaRejectedError`.
  - Rejected: accepting a bare `N ` (number + space) as a marker. It fires on "2 coffees".
  - Rejected: asking the LLM to split the storyboard. The spec says code splits it, and the split must be checkable.
- **Script checks.** These are added on top of F10/F11:
  - With a storyboard, `scriptProblems` requires exactly one shot per beat.
  - A quote that sits in beat k must land in shot k (via `placeQuotes`' `shotOf`). A quote in the shared context
    (before beat 1) may go in any shot.

  Pre-spend, for $0, rejects:
  - a beat whose quotes need more than 15 s;
  - a beat that gives lines to two different speakers (one speaker per shot);
  - beats whose minimum lengths add up to more than 30 s.

  `fitsShots` now packs greedily into ≤ 4 shots, which is optimal for contiguous groups. The speaker-turn limit
  follows `MAX_SHOTS` (4 turns).
- **Script prompt `script-v5`.**
  - The close-framing rule is gone. In its place are the size enum, "wide/full to set the place, then a medium
    close-up for the key line", no two close-ups in a row outside a dialogue, wide only when the place matters and
    composed vertically (character in the lower third), and "on a wide size the line is heard, not lip-read".
  - The look must include 2–3 high-contrast distance cues, repeated identically.
  - `visual` and the other description fields are written in English.
  - `firstPrompt(idea, quoted, board?)` adds a "Beat k (shot sk): …" block. The board is parsed from the idea when
    not passed, so callers (graph estimate, preflight) stay unchanged.
- **Visuals prompt `visuals-v4`.**
  - Body order: `Shot size: <camera>.`, then one camera move (wide: locked-off or one slow crane/pull-back; close:
    locked-off with at most a push-in), then the subject (wide only), the action (visual + motion), and the
    voice/line.
  - On a wide shot the subject is `<Name> is small in frame, full figure visible, recognisable by <look>; the place
    dominates, composed vertically …`. The keyframe uses the same sentence instead of "face clearly visible, mouth
    closed".
  - A wide line is `Delivery: <emotion, tags>. <Name>, small in frame, says in English: {line}`. The delivery moves
    to its own sentence so the dialogue sentence matches the spec and nothing follows the brace.
  - Close sizes keep the F11 sentence exactly. The audio policy, the constraint tail, the portrait refs and the
    real-face ladder are unchanged.
  - Not done: a subject line for close sizes. The keyframe (first frame) already fixes identity there, and repeating
    the look would only lengthen a prompt the guide wants short.
- **Judge `judge-v3`.**
  - The keyframe rubric switches items 2 and 6 by size: a wide shot is judged on whether the character is
    recognisable by its look, anatomically whole, and the setting matches and dominates.
  - The clip rubric for wide sizes drops the mouth item and checks for duplicated, merging or melting figures and
    for stable architecture.
- **Wide-shot fallback (`src/nodes/visuals.ts`).** After native speech fails, a wide shot still gets the verified
  TTS (F04 `verifiedVoice`), then:
  1. `muxArgs` replaces the audio of the closest native clip, keeping the video stream and its length. The clip
     must be long enough for the speech, or the shot fails with a reason.
  2. `linkSource` lets the mock ASR hear the voice.
  3. The muxed file goes through the verbatim gate (stage `voiceover`), and a miss throws `VerbatimError`.

  The `fallback` attempt's reason says "voice-over without lip-sync (wide shot…)". No lip-sync call is made, and
  `regenEstimateUsd` no longer counts a lip-sync for wide shots. Models without native speech also take this path
  on wide shots. `evals/metrics.ts` counts a failed `voiceover` attempt as a verbatim miss.
- **Mocks.** The mock script writer moved to `src/providers/mock-script.ts` to keep `mock.ts` small; it is still
  exported from `providers/index.ts`.
  - With a storyboard: one shot per beat. A beat that names a place gets a "wide shot". The rule is an English +
    Ukrainian stem list (hall, castle, street, sea, зал, замк, вулиц, …).
  - Without a storyboard: a wide establishing shot when the idea names a place, else a "medium shot", then the line
    on a "medium close-up". Dialogues stay close-up shot-reverse-shot, now up to 4 turns.
  - Mock looks gained bright colours (distance cues).
- **Cost estimate.** It assumes one shot per storyboard beat (else 2): one portrait plus one keyframe per shot, 8 s
  per shot capped so the total stays ≤ 30 s (4 shots → 7 s each), and ASR per shot plus one. `Budget` already
  guards each call and reserves per parallel shot, so 4 shots needed no change there.
- **Evals.** Three ideas were added to `evals/hard.jsonl`: `storyboard-castle-uk`, `storyboard-four-beats` and
  `wide-cliff-no-storyboard`. The mock run `evals/results/2026-10-19-f12-mock.json` has all three ok. The only
  failures are the three intended pre-spend rejections from F10.
- **No new dependencies.**
- **Docs checked.** I used `docs/research/seedance-playbook.md` (§1 Structure, camera, dialogue syntax) and the
  research notes in this spec. I fetched no new URLs.
