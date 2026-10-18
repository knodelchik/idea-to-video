# F11 — Two speakers, and prompts written the way Seedance 2.0 documents them

## Goal
1. **Dialogue.** "Make them talk to each other" is the most natural hard idea. Today the contract has one
   `Character`, so Gemini gives both lines to one person, who then says "…, Mom." to herself; every check passes
   (silent semantic failure, `docs/hard-ideas-report.md` #4). Support 1–2 characters, one speaker per shot.
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
