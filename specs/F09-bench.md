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
- **Layout.** `scripts/bench.ts` handles the CLI (args, the live gate, provider wiring, writing files). The logic is in
  `src/bench/`:
  - `registry.ts`: models, list prices, durations, the cost plan.
  - `run.ts`: fixed inputs and one model through its path.
  - `report.ts`: the markdown table and the grid.
  The pure grid builders `gridLayout` / `gridArgs` are in `src/media/args.ts`, next to the other ffmpeg builders.
- **Registry = one row per (model, path).** The spec chooses the path from the model's kind and `nativeSpeech`. The
  registry entry's own `nativeSpeech` flag decides it, so one live model can be measured both ways:
  - `seedance-2.0` and `seedance-2.0-fast`: native;
  - `seedance-2.0+lipsync`: the same Seedance 2.0, run silent and then lip-synced;
  - `kling-avatar-v2` and `kling-avatar-v2-pro`: talking.

  `--models` runs entries in the order given; unknown, repeated or empty lists exit 2. Models from the research
  shortlist that have no adapter yet (Omni Flash, Kling 3.0, H3, Wan 3.0) are left out of the registry. Adding one
  means an adapter, a mock path and a registry entry.
- **New live adapter: `FalKlingAvatar`** (`src/providers/talking.ts`, `klingAvatarFromEnv`). The `talking` path
  needed a live adapter, and none existed. It has standard and pro tiers. Its mock twin is `MockTalking`, and the
  unit test uses a fake fal. It is billed on the *measured* output seconds (ffprobe), not on the reply's `duration`.
  `estimateUsd` can't probe, so for the budget guard it assumes a 10 s clip. `createProviders("live")` is not
  changed: the pipeline still needs a `talking` override. Wiring it there is a separate decision.
- **Costs.** `$ registry` is the list price × the planned seconds:
  - video: voice + 1 s, snapped up to an allowed duration;
  - talking: the audio length, rounded up to whole seconds;
  - the lipsync path adds Kling lip-sync (5 s billing steps), unless `LIPSYNC_PROVIDER=command`.

  `$ reported` is what the providers returned, ASR and judge included (0 for mocks). The plan also adds rough upper
  bounds for the fixed inputs ($0.099) and for ASR + judge on each row ($0.02).
- **Live gate.** The plan and estimate are printed in both modes. `--live` without `--yes` returns exit 1 before any
  provider is *built*. Building comes first in the order of operations, so a call is impossible. The test injects a
  provider factory that throws and asserts it was never called and no directory was created. With `--yes`, an
  estimate over `MAX_COST_USD` is also refused before anything is built. Every call then goes through one `Budget`
  via `withBudget`. Stubs fill the slots a row does not use, and they throw if called.
- **The spec's `LIPSYNC_MODEL`** maps to the existing `LIPSYNC_PROVIDER` / `lipsyncFromEnv` (F05). I added no second
  env var for the same choice.
- **Fixed inputs.**
  - Keyframe: `portraitPrompt` of a fixed bench `Script`, which is a close-up with the face large in frame.
  - Voice: `verifiedVoice`, so it is ASR-checked verbatim before any model sees it.
  - Default line: "I kept every letter you never sent." Change it with `--line`.

  Both inputs and every clip are content-addressed (`once`) under `runs/bench/`. A re-run, or a resume after a
  crash, reuses finished rows, and the table marks their wall time "(cached)".
- **Metrics.**
  - WER: `listen()` on the clip itself. A clip with no audio track gets WER 1 without calling ASR, because live
    Groq ASR throws on silent input (an F05 lesson).
  - Judge: the F07 `judge("clip")` on 3 frames, with the keyframe as reference.
  - A model that throws becomes a `FAILED:` row. The bench goes on, and the run still exits 0.
- **Grid.**
  - `xstack` in reading order, 360×640 tiles, `fill=black` for empty cells, as long as the longest clip (shorter
    clips hold their last frame).
  - It is silent: five voices at once is noise, and every clip keeps its own audio.
  - The dev ffmpeg has no `drawtext` (F02), so tile k is labelled with k white `drawbox` squares.
  - The `#` column is the cell number. Failed rows get "—" and no cell.
- **File names.** Live writes `docs/bench/<date>.md` and never overwrites: a second run that day becomes `<date>-2`. A
  mock run writes `<date>-mock.md`, so the acceptance command can never clobber a paid result. `.gitignore` ignores
  `docs/bench/*-mock*`.
- **New dependencies:** none.
- **Docs checked:**
  - https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard/llms.txt and `.../v2/pro/llms.txt`: inputs,
    `video.url`, $0.0562/s and $0.115/s.
  - https://ffmpeg.org/ffmpeg-filters.html: `xstack` (`layout`, `fill`), `drawbox`, `tpad`.
  - Local `ffmpeg -filters` lists `xstack` and `drawbox`.
- **Acceptance 2 evidence.** A repo hook blocks any shell command containing `--live`, even without `--yes`, so I
  could not run the CLI by hand in live mode. `tests/bench.test.ts` ("live gate") drives `main(["--live"])` directly
  and checks the printed models and estimate, exit 1, zero provider construction, and nothing written.
