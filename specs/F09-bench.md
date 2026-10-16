# F09 — Model benchmark

## Goal
Choose the video stack by measurement, not by reputation. Same keyframe, same verified audio, several models,
the same metrics.

## Scope
- `scripts/bench.ts --mock|--live [--models id,id] [--line "..."]`:
  1. Fixed inputs, generated once and cached: one keyframe (portrait close-up) and one verified TTS line.
  2. For each model in the list run the applicable path:
     - `video` model → i2v → lip-sync (`LIPSYNC_MODEL`);
     - `video` model with `nativeSpeech` → i2v with the line in the prompt, **no** lip-sync; ASR the clip → WER
       (this is the "native" mode measured, not used in production);
     - `talking` model → image + audio → video.
  3. Per result: cost (registry), wall time, WER of the clip audio, judge clip score (F07), output path.
  4. Writes `docs/bench/<date>.md` (table + notes column left empty for the human) and `docs/bench/<date>-grid.mp4`
     (results side by side with ffmpeg `xstack`, each labelled by position order in the table).
- Before any live call: print the planned models and total estimated cost, require `--yes`.
- Test: mock path produces the table and grid (`tests/bench.test.ts`).

## Acceptance
1. `npx tsx scripts/bench.ts --mock` exits 0 and writes the markdown table and grid video.
2. Live mode without `--yes` prints the estimate and exits without calling providers.
3. `pnpm verify` green.

## Decisions
_(implementer fills in)_
