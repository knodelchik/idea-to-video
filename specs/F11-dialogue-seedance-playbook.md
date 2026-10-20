# F11 — Two speakers, and prompts written the way Seedance 2.0 documents them

## Goal
1. **Dialogue.** "Make them talk to each other" is the most natural hard idea. Today the contract has one
   `Character`, so Gemini gives both lines to one person, who then says "…, Mom." to herself; every check passes
   (silent semantic failure, `docs/research/hard-ideas-report.md` #4). Support 1–2 characters, one speaker per shot.
2. **Prompts per the official Seedance 2.0 guide** (`docs/research/seedance-playbook.md`, sources S1–S9). Our
   current wording repeats and annotates the line ("Exactly these words, once, …"), which the guide says can
   trigger burned-in subtitles, and uses an undocumented reference syntax.

## Scope
### Contract (`src/schemas.ts`, change first)
- `Script.characters: Character[1..2]` (unique `name`), each with `look` and `voice {gender, age, tone}` plus a new
  `voiceDescription` string (one sentence, e.g. "warm low female voice, mid-30s, neutral American accent,
  unhurried") that is repeated verbatim in every shot where that character speaks.
- `Shot.speaker`: the `name` of a character, required when `line` is non-empty; `Shot.onScreen`: names visible in
  the shot (the speaker must be among them).
- Old manifests/scripts with `character` must still parse (migrate `character` → `characters: [character]`, every
  spoken shot's speaker = that name). Keep `RunManifest` backward compatible.
- `scriptProblems`: each quoted line in the idea is spoken by a plausible speaker. When the idea attributes lines
  ("she says … he answers …"), different attributions must map to different characters; a script where one
  character addresses itself by the other's role is the bug to catch: at minimum, reject a script whose idea names
  two speakers but `characters.length === 1`.

### Visuals
- One portrait per character (`cast` makes N portraits; content-addressed per character).
- Portrait prompt per the official headshot spec: "Front-facing close-up framed above the shoulders, the face
  filling about two-thirds of the frame, neutral expression, mouth closed, plain light-grey background, even soft
  light. Vertical portrait." No multi-view sheets.
- Keyframe refs: the portraits of everyone `onScreen` (speaker first), plus the previous keyframe.
- Talking shot refs ladder (F05 `frame → refs → text`): in `refs` mode send the speaker's portrait first, then
  other on-screen portraits, then the keyframe.

### Seedance prompt (`src/prompts/visuals.ts`, bump `VISUALS_PROMPT_VERSION`)
Use the documented syntax (playbook "Changes we should make" 2–8):
- Dialogue: `<Name> says in English: {<line>}` — braces, no quotes, nothing repeated or annotated after the line.
  Delivery/emotion goes **before** the line ("…, quietly, says in English: {…}").
- References: `@Image 1 (<Name>)` style, numbered by upload order, a noun right after every tag; the keyframe is
  `@Image N (opening frame)`.
- Audio policy at the **start**: "Audio policy: only <Name>'s spoken line plus quiet natural room tone; no music,
  background music, BGM, score, instrumental, melody, soundtrack, synth, ambient pad or stinger at any moment."
- Constraint tail at the **end**: "Generate audio strictly according to the dialogue; do not add or remove any
  words; one speaker only; clean, clear, standard pronunciation. No music of any kind. The character's face remains
  stable and consistent throughout, without deformation; hands anatomically correct; natural, smooth movement.
  Only one <Name> in frame; no duplicate or twin. Avoid generating subtitles, captions, a logo or a watermark."
- `Voice: <voiceDescription>` sentence in every spoken shot of that character.
- Keep: one camera move per shot, the no-legible-writing rule.
- Gemini script prompt (`src/prompts/script.ts`, bump its version): 1–2 characters; each spoken shot has exactly
  one speaker; a dialogue becomes two shots (shot-reverse-shot), one line each; write `voiceDescription`.

### Assembly
- 200 ms audio fade-out at the end of every clip segment (official fix for the end-of-clip click), on top of the
  existing 50 ms edge fades.

### Mocks and judge
- Mock script responder: two quoted lines attributed to different people in the idea → two characters, one line
  each. Mock video/judge accept the new fields.
- Judge clip rubric: "same person as the speaker's portrait" (pass the speaker's portrait as the ref).

## Acceptance
1. Contract tests: 1 and 2 characters parse; a spoken shot without `speaker`, an unknown speaker, or a speaker not
   `onScreen` is rejected; an old single-`character` script/manifest still parses and migrates.
2. `npx tsx src/cli.ts 'At the kitchen table, a mother slides an envelope to her son. She says: "Open it after I leave." He looks up and asks: "Mom, are you sick?"' --mock --json` → ok, 2 characters,
   s1.speaker ≠ s2.speaker, both lines verbatim in the final file.
3. Prompt tests pin the exact Seedance wording: braces dialogue with `says in English: {…}`, no text after the
   closing brace within the same sentence, audio policy first, constraint tail last, `@Image 1 (<Name>)` refs in
   upload order with the speaker's portrait first.
4. In `refs` mode the speaker's portrait is reference 1 (call recorder on MockVideo).
5. `pnpm verify` green; all F01–F10 tests still pass (update tests only where the contract changed, never weaken an
   assertion about verbatim).

## Decisions
- **Contract.** `Character` gains a required `voiceDescription`. `Script.characters` is 1–2 entries with unique
  names. `Shot` gains `speaker?` and a required `onScreen` (≥ 1 name). The cast rules live in one function,
  `castProblems` (`src/schemas.ts`), used both by `Script.superRefine` and by `scriptProblems`, so the model gets the
  same messages the contract enforces. These rules are: a spoken shot needs a speaker, the speaker must be a known
  character, the speaker must be on screen, and onScreen names must be known.
- **Back-compat by migration, not by optional fields.** `Script = z.preprocess(migrateScript, RefinedScript)`. A
  pre-F11 object with `character` is migrated as follows:
  - `character` becomes `characters: [character]`;
  - every spoken shot gets `speaker` = that name, and every shot gets `onScreen` = `[name]`;
  - `voiceDescription` is built from the voice fields, e.g. "tired, warm female voice, young".

  `RunManifest.script` uses the same schema, so old manifests parse. `ScriptDraft` (what Gemini sees as a JSON
  schema) stays a plain object without the preprocess, so `z.toJSONSchema` is unchanged in kind.
  - Rejected: keeping `character` as an optional alias next to `characters`. It gives two sources of truth, and
    every consumer would branch on it.
  - Not covered: resuming a *pre-F11 checkpoint* past `cast`. Graph state renamed `portrait` → `portraits`, and
    checkpoint state is not re-parsed. Manifests still read fine.
- **Who says what is code (`src/speakers.ts`), and it is conservative.** Each quote's speaker comes from the
  first of these that applies:
  1. Its lead-in: the subject of the last speech verb before it ("She says:", "He looks up and asks:").
  2. Its trailing tag: `"…," she says.`, `"…?" asks her son.`, `"…!" the detective snaps.` A tag must continue the
     quote's sentence (it starts with a comma, a dash or a lowercase word) and reach its verb before any sentence
     break. The text the tag uses is removed from the next quote's lead-in. Without this, `"A," she says. "B," he
     asks.` credited "she" to B (attempt-1 review).
  3. The previous quote's speaker.

  The subject of a clause is read after dropping a leading subordinate clause up to its comma
  (as/when/while/after/before/once/if/until/since/because/though/although, optionally after connectives): in
  "As she opens the door, her husband asks" the husband speaks (attempt-2 review). Rejected: "prefer the gendered
  noun right before the verb over any pronoun". It breaks "He hugs his mother and says", where the pronoun is
  the subject. Without a comma nothing is dropped, so "When she finally speaks" keeps its she. Then the subject is:
  - a she/he anywhere in what is left ("Then she adds", "Finally, he whispers"), or
  - after leading connectives ("then", "finally", …) are dropped, a gendered noun among its first 3 words, else its
    first content word.

  Possessives ("the bride's", "my sister's") are skipped, so "The bride's father" is a male "father".
  Two attributions count as *different* only when:
  - their genders differ, or
  - both are nouns and the nouns differ.

  So "the mother … she adds" is not flagged.

  `scriptProblems` adds three checks:
  1. If the idea has different speakers and the script has 1 character, the script is rejected. This is the
     spec's minimum.
  2. Lines from different speakers must not share a speaker.
  3. A she/he line must go to a character with that voice gender. This is the deterministic form of "plausible
     speaker".

  `preSpendProblems` rejects ideas with more speaker turns than shots (> 2) for $0, because one speaker per shot
  makes them impossible. Over `evals/ideas.jsonl` + `evals/hard.jsonl` this gives no false positives: only the two
  dialogue ideas have 2 speakers. "A teenager hugs her dad" does not become male, because only the subject's own
  first words count. The hard eval set has the same 16/19 per-idea results as F10's run, and the 3 failures are the
  intended pre-spend rejections.
  - Rejected: asking the LLM who speaks. That is unverifiable, and it is the same model that made the bug.
- **Prompts (`visuals-v3`).** Built from three parts, so the order is structural, not string-patched:
  - start: the audio policy;
  - middle: the body, with scene, one camera move, silent listeners, `Voice: <voiceDescription>.`, and the
    `Name looks toward the camera and, <delivery>, says in English: {line}` sentence;
  - end: the constraint tail.

  Details:
  - `Voice:` is placed *before* the dialogue sentence. That way nothing annotates the line after it.
  - Judge issues are inserted *before* the tail through `issuesNote` (`talkingPrompt(shot, script, { issues })`). This
    replaces wrapping the full prompt in `withIssues`, which would have pushed the tail off the end.
  - `textToVideoPrompt` takes `refs: string[]`, the labels in upload order (character names, then
    `"opening frame"`). Every mention of a referenced character is its `@Image N (Name)` tag.
  - In a shot with two people on screen, the tail says "Each character's face…" and "Only one A and one B in frame".
    With one person it uses the spec's exact wording.
- **Portraits.** `castCharacters` makes one portrait per character. It is content-addressed by its prompt, which holds
  the name and the look. The `Portraits` type is `string | Record<name, path>`. A single path is shorthand for a
  one-character script, so single-character callers and F05/F07 tests kept their shape. The refs ladder is:
  - keyframes: on-screen portraits, speaker first, then the previous keyframe;
  - `refs` mode: the speaker's portrait, then the others, then the keyframe;
  - judge: the keyframe is judged against the on-screen portraits, and the clip against the speaker's portrait
    (`judge-v2` rubric names the speaker).

  The fallback TTS uses the speaker's voice.
- **Assembly.** `segmentArgs({ endFade })` adds a second `afade=t=out` over the last 200 ms (`END_FADE`). It sits on
  top of the 50 ms edge fades, and the gains multiply. Segments end ≥ 0.4 s after the last word (`SPEECH_TAIL`), so
  the fade never touches speech. `END_FADE` is part of the segment cache key.
- **Mock writer.** It groups quotes by speaker run with the same `quoteSpeakers`. Two runs make two characters,
  shot-reverse-shot with one line each, and their genders come from she/he. One run keeps the old shape, with the
  voice gender taken from the idea, so "He says" gets a male voice.
- **Tests changed only where the contract changed.**
  - Fixtures gained `characters` / `speaker` / `onScreen` / `voiceDescription`.
  - Quote assertions became brace assertions with the same verbatim strength.
  - The removed "Exactly these words…" wording is now asserted absent.
  - The F10 detective fixture ("He asks…") got a male voice, because the new plausibility rule applies to it.
- No new dependencies. Sources: `docs/research/seedance-playbook.md` §1 (dialogue braces, `@Image N (noun)`,
  negatives), §4 (voice description, music enumeration, end-click fade), and "Changes we should make" 2–8. No
  external docs were fetched for this feature.
