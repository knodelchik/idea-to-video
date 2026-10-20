# F13 — Burned-in subtitles of the verified line, and My Muse pacing (cuts inside a clip)

## Goal
A real My Muse episode (`docs/research/framing-my-muse.md`, measured 2026-10-19) cuts every ~2.5 s, keeps a line
running over reaction / insert / back shots, and burns white bold subtitles (2–6 words) into every shot. Our output is
one 5–12 s take per shot with no subtitles, so it feels slow next to theirs. Two changes:
1. **Subtitles** of the line, exact by construction (the text is the verified line, never ASR text, never Seedance's
   own captions), timed by ASR word timestamps.
2. **Cuts inside a clip:** a shot may hold 2–3 cuts generated in ONE Seedance call with the multi-shot prompt form
   ("Shot 1: … Shot 2: …", Runway's Seedance 2.0 guide 2026-09-24), so pacing gets close to 2–4 s per cut at no extra
   cost.

## Scope
### Contract (`src/schemas.ts`, change first)
- `Shot.cuts?: Cut[]` with 2–3 entries, `Cut = { camera (F12 sizes), visual, onScreen: string[] }`. When present, the
  first cut is what the keyframe shows; `Shot.camera`/`visual` stay (= the first cut) for back-compat. A cut does not
  have its own seconds (Seedance decides inside the clip); a shot with cuts must be ≥ 6 s.
- Old scripts/manifests without `cuts` parse unchanged.
- `RunManifest.subtitles?: { file: string, cues: { start, end, text }[] }` (what was burned).

### Script prompt (`src/prompts/script.ts`, bump version)
- A shot of 6 s or more should usually have 2–3 cuts, My Muse grammar: e.g. wide/full to set the place → medium shot →
  close-up on the emotional peak; or speaker → listener's reaction while the line continues; inserts (hands, an object)
  allowed. The speaker need not be on screen in every cut (line continues off-screen). Never two identical sizes in a
  row. With a storyboard (F12) a beat may become one shot with cuts; the beat order is kept.
- Medium shots are the default; close-ups for the emotional peak only.

### Video prompt (`src/prompts/visuals.ts`, bump version)
- A shot with cuts renders as: audio policy (first) → `Shot 1: <size>, <camera move>, <visual>. Shot 2: … Shot 3: …` →
  the dialogue sentence once, after the shot list, F11 syntax (`<Name> says in English: {line}`; when the speaker is
  not in every cut add "the line continues over the cuts") → the constraint tail (last), which already forbids
  subtitles. Keep identity cues per character in every cut that shows them.
- The real-face ladder and refs are unchanged. Text-to-video prompts get the same shot list.

### Fallback with cuts (`src/nodes/visuals.ts`)
- Lip-sync on a clip with internal cuts is wrong (faces change between cuts): if native speech fails on a shot with
  cuts, use the F12 voiceover path (verified TTS without lip-sync, `via: "voiceover"`).

### Subtitles (`src/nodes/subtitles.ts` new + `src/nodes/assemble.ts`)
- Cues come from the **expected** line text (after `splitDelivery`), split into chunks of 2–6 words, breaking at
  punctuation first, never inside a word; each chunk ≤ 32 characters per line, max 2 lines.
- Timing: align the chunk's words to the ASR words of the final assembled timeline (the same alignment the verbatim gate
  already does, so numbers like "1987" ↔ "nineteen eighty-seven" align). Each cue starts at its first word's start and
  ends at its last word's end + 0.15 s (min 0.8 s on screen, no overlap, a gap < 0.25 s is closed). If timestamps are
  missing, spread cues over speechStart–speechEnd by word count, and record that in the manifest.
- Rendering: this ffmpeg build has no `drawtext`/`subtitles` filters, so render each cue to a transparent PNG
  (1080 px wide) with `@resvg/resvg-js` (system fonts; family "Arial, Helvetica, DejaVu Sans, sans-serif", bold, white,
  black stroke ~6 px, soft shadow, centred, baseline at ~72% of the height — the lower third, clear of the UI) and
  overlay with `overlay=enable='between(t,a,b)'`. Content-addressed like every other artifact.
- Sanity check by code: the concatenated cue texts equal the expected line text (whitespace-normalised). Fail loudly
  otherwise.
- `--no-subtitles` CLI flag (and `SUBTITLES=0`) turns it off; default on.
- The final gate stays as it is (ASR of the final audio). Order: assemble → subtitles burn → finalGate on the burned
  file.

### Mocks
- MockAsr already returns words with timestamps; the mock e2e must produce a final file with subtitles burned in.
- Mock script writer: a ≥ 6 s shot gets 2 cuts (wide → medium) when the idea mentions a place, else speaker → close-up.

## Acceptance
1. Contract: shots with 2–3 cuts parse; 1 or 4 cuts fail; a cut shot under 6 s fails; old scripts parse.
2. `tests/subtitles.test.ts`: chunking of "It stopped in 1987, at 3:15 a.m., and so did I." keeps "1987" and "3:15
   a.m." intact and breaks at commas; cue timing from ASR words (numbers aligned to spoken words); min duration and
   no-overlap rules; joined cues == line; fallback spread when no timestamps.
3. A rendered cue PNG is 1080 px wide with transparent background (alpha present) and non-empty pixels in the lower third.
4. `npx tsx src/cli.ts 'A tired barista finds a note in the tip jar: "Meet me where it started."' --mock --json` → ok;
   the manifest has `subtitles.cues` whose joined text equals the line; the final file differs from the same run with
   `--no-subtitles` (frames differ in the lower third) and both pass the final gate.
5. Prompt tests: a cut shot's video prompt has `Shot 1:` … `Shot 2:` in order, the dialogue sentence exactly once after
   the shot list, audio policy first, constraint tail last.
6. Visuals test: native speech fails on a shot with cuts → voiceover path, no lip-sync call.
7. `pnpm verify` green; F01–F12 tests still pass (never weaken a verbatim assertion).

## Decisions
- **Contract.** `Cut = { camera, visual, onScreen }`; `Shot.cuts?` is checked by `cutProblems` inside a
  `superRefine` on `Shot`, so a bad shot fails at the boundary and the script node's retry gets the same messages.
  The rules: 2–3 cuts, ≥ 6 s (`CUT_SHOT_MIN_SECONDS`), `shot.camera` equals the first cut's, never the same size twice
  in a row, and a cut shows only characters in the shot's `onScreen` (empty `onScreen` = an insert).
  `openingOf(shot)` is the framing the keyframe and the judge's "matches the shot" item use. Rejected: dropping
  `Shot.camera`/`visual` when there are cuts. Readers from before F13 would break.
- **Prompts.** `script-v6` adds the cut grammar (wide → medium → close-up on the peak, speaker → reaction, inserts,
  speaker may be off screen) and makes medium shots the default. `visuals-v5` writes a cut shot as
  `Shot 1: <size>, <move>, <visual>. Shot 2: …`, identity cues in every cut that shows a character, then the dialogue
  sentence once (`<Name> says in English: {line}`, with "the line continues over the cuts" when the speaker is not in
  every cut). The audio policy stays first and the constraint tail last. `judge-v4` tells the clip judge that the
  hard cuts are intended.
  The pinned version tests (`tests/visuals.test.ts`, `tests/script.test.ts`) were moved to the new versions, the same
  way F12 moved them.
- **Fallback.** A cut shot whose native speech fails goes to the F12 voice-over path (`via: "voiceover"`), never
  lip-sync. The fallback reason says "the clip has cuts".
- **Subtitles.** Cue text comes from the expected line (`splitDelivery`) via `chunkLine`: punctuation first, then
  even splits, 2–6 words, ≤ 2 × 32 chars, and "3:15 a.m." / "1987" kept whole. Timing uses `alignPieces` in
  `src/verbatim.ts`, the gate's own alignment and number readings, against ASR of the assembled cut. A cue ends at its
  last word + 0.15 s, stays up at least 0.8 s, never overlaps, and gaps < 0.25 s are closed. With no timestamps the
  cues are spread over the speech window and the manifest records `timing: "spread"`. `assertCuesMatch` fails loudly
  if the joined cues ≠ the line.
  A one-word phrase ("Yes,", "Okay.") joins the next piece, or failing that the previous one. If the neighbour is
  already full (a 6-word split piece), the word and the neighbour are re-split together with `splitRun` (attempt 3).
  "Yes, I am the one who kept every single letter you sent me." → `Yes, I am the | one who kept | every single
  letter you sent me.`. The merge is applied only if every resulting piece has ≥ 2 words and fits. Rejected: letting
  a merged cue grow to 7 words, which breaks the 6-word cap.
- **Rendering.** The ffmpeg build has no `drawtext`/`libass`, so each cue is a transparent 1080×1920 PNG made with
  `@resvg/resvg-js` (dependency added in commit 9d6017d "deps: @resvg/resvg-js for subtitle cards"; system fonts,
  bold white, ~6 px black stroke, soft shadow, baseline at 72 %). The PNGs are overlaid with
  `overlay=0:0:enable='gte(t,a)*lt(t,b)'`, and the audio is copied untouched, so the final gate hears exactly what was
  verified. Cards and the burned file are content-addressed (`CARD_VERSION`). Rejected: a libass/drawtext build of
  ffmpeg (a system change on every machine), and node-canvas (a native build with Cairo).
- **Graph.** assemble → `burnSubtitles` → finalGate, so the gate runs on the burned file. `--no-subtitles` and
  `SUBTITLES=0` record a `subtitles` attempt with reason "off". The choice is stored in state, so a resumed run keeps
  it.
- **Mock writer.** A shot of 6 s or more gets 2 cuts: wide → medium when the idea (or the beat) names a place, else
  the speaker's size → close-up. A close-up opener becomes a medium close-up so no size repeats.
- **Opening cut = keyframe (after the human note).** `cutProblems` rejects a first cut with `onScreen: []` ("cut 1
  is the opening frame (the keyframe) and must show at least one character"). `openingCastOf(script, shot)` in
  `src/schemas.ts` is `castOf` filtered to `cuts[0].onScreen`, so the speaker stays first when present. It throws
  rather than return an empty cast for a hand-built Shot that skipped the schema (no silent fallback).
  `keyframePrompt`, `keyframeRubric` (wide/close wording from `openingOf(shot).camera`) and the new
  `keyframePortraits` use it, and so do the keyframe's image refs and the keyframe judge's refs. `shotPortraits`
  (the whole shot's cast) stays for the video call, so characters from later cuts still get their portrait refs
  there. Version bumps: `visuals-v6`, `judge-v5`, `script-v7` (the writer is told inserts go only in cut 2 or 3).
  The mock writer needed no change: its first cut is always the speaker. Rejected: putting later-cut characters
  in the keyframe "off frame", which would still pull their faces into the first frame.
- Docs referenced (not re-fetched in attempt 2): Runway's Seedance 2.0 prompting guide (multi-shot "Shot 1: … Shot 2: …" form, 2026-09-24, via
  `docs/research/framing-my-muse.md`); ffmpeg filters `overlay` / timeline `enable`
  (https://ffmpeg.org/ffmpeg-filters.html#overlay-1, https://ffmpeg.org/ffmpeg-filters.html#Timeline-editing);
  resvg-js README (https://github.com/thx/resvg-js).
- **No overlap at frame boundaries (review fix).** Cues abut: `settle` sets a cue's end to the next cue's start.
  `between(t,a,b)` is inclusive at both ends, so on a frame that lands exactly on the boundary (e.g. 3.5 s at 30 fps)
  both cards were drawn. The enable window is now half-open, `gte(t,a)*lt(t,b)` (ffmpeg expression functions, same
  Timeline-editing doc as above). Degenerate input (two cues on the same instant, or a zero-length spread window) used
  to get a fixed 0.05 s sliver that could run past the next cue's start. Now a next start less than a sliver after the
  current one is pushed to current start + sliver, which is the only case where a start moves. A sliver left by the
  video-end clamp is capped at the next start. Rejected: capping the sliver alone, which leaves a zero-length window
  that `overlayCuesArgs` rejects; and dropping the cue, which would break joined cues == line.

## Human note after BLOCKED (2026-10-19)
The reviewer is right: the keyframe is the first frame of the clip, so it must show the **first cut**, not the whole
shot. Decision (do both):
1. **Contract:** the first cut of a shot must show at least one character (`cuts[0].onScreen` non-empty). Inserts
   (hands, an object, `onScreen: []`) are allowed only as cut 2 or 3. Reason: the keyframe anchors identity and is what
   the portrait refs and the real-face ladder work with; an insert as the opening frame gives Seedance no face to keep.
   Add this to `cutProblems` with a clear message and tell the script writer (bump the script prompt version).
2. **Keyframe prompt and keyframe judge for a cut shot use the opening cut only:** its camera, visual and `onScreen`.
   The cast is `cuts[0].onScreen` (speaker first if present), and the wording follows that cut's size (F12: wide sizes
   get "small in frame…", close sizes keep the face wording). Characters who appear only in later cuts are not in the
   keyframe prompt or rubric; they still get their portrait refs in the video call.
Tests: a cut shot whose first cut shows only the listener → keyframe prompt and rubric name only the listener; a first
cut with `onScreen: []` is rejected by `cutProblems`; a wide first cut gets the wide wording.
