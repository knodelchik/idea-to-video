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
