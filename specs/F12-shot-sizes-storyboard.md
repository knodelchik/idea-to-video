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
