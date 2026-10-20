# F20 — A failed run that a reviewer understands and can continue, and gate regressions caught for $0

## Goal
A reviewer will try the hosted demo once or twice, so a failure they don't understand costs us the impression. Two
live runs failed (2026-10-19 run 6f4903 and 2026-10-20 run a20fab, $2.9 each), and the video was good both times.
The verbatim gate rejected words that sound the same: "Kiev"/"Kyiv", "tickets"/"ticket's", "for $50"/"$4.50". Then the
page showed a red "Failed ✗", a raw error and an attempts table, with nothing to press. The author had to read the
manifest, fix the code and run `--redo` over ssh.

Two parts:
1. The failure page says, in plain words, what happened and why the agent refused to ship. It shows what was already
   made and offers one button to continue from the failed step.
2. Real ASR transcripts become a regression set in `pnpm verify`, so a gate change is checked against what Whisper
   really writes, for $0.

## Scope

### 1. A failure explained (pure, `src/web/explain.ts`, used by the API and the UI)
- `explainFailure(manifest) → { title, what, why, next, step, shotId?, expected?, heard?, diff? }`. It reads the last
  failed attempts and `manifest.error`. There are known kinds, each with plain English text (the UI is English):
  - **verbatim:** a gate `sub`/`ins`/`del`. *What* is "Shot s2: the spoken line was not word-for-word, so the agent
    refused to ship it." *Diff* lists the expected and heard words with the mismatched ones marked (from the attempt's
    ops; there is no new ASR call).
  - **voice too long:** a voice-over or lip-sync length failure.
  - **refused:** every rung of the ladder was refused by the content policy (real-person filter).
  - **budget:** MAX_COST_USD was reached.
  - **provider:** a provider error, timeout or 5xx after retries.
  - **judge:** the clip or keyframe was below the bar after the allowed retries.
  - **unknown:** fallback with the raw error, never an empty page.
- `step` is the graph step to continue from (one of `REDO_STEPS`): the node of the first failed attempt, mapped
  (`shot` for video/voice/voiceover/lipsync/listen, `finalGate` for final, etc.).
- `next` is honest about what continuing can do:
  - **verbatim on native takes:** "Continue makes new takes of this shot (~$X); shots that passed are reused for $0."
  - **after a code fix:** the gate is re-run on the saved takes.
  - **provider/budget:** "Continue retries from <step>; everything finished is reused."

### 2. Continue button (web)
- **`POST /api/runs/:id/continue`** (auth, same one-active-run lock as a new run). It spawns
  `cli.ts --resume <id> --redo <step> --json`, with `MAX_COST_USD` from the server config applied to the new spend.
  It returns 409 if a run is active and 400 if the run is not `failed`/`interrupted` or has no checkpoint.
- **CLI `--fresh-takes`** (with `--redo shot`): the failing shot(s) skip the cached-clip jump and make new native takes.
  Shots that passed (their verified result is in the checkpoint) are still reused. The button passes `--fresh-takes`
  when the failure kind is verbatim on native takes and the saved takes were already re-gated by the current code.
  That is the case when the failed attempt's gate version equals the current one: store `gateVersion` on verbatim
  attempts, a constant in `verbatim.ts` that is bumped when matching rules change.
- **Cost estimate** shown on the button: the failing shots' seconds × the video price per second × 1 take, plus
  TTS/ASR/judge. It is $0.01 when no new video is needed.
- **The failure panel** (replaces the bare red error):
  - the title;
  - *what* and *why*;
  - the expected/heard diff (mismatched words highlighted);
  - the best take of the failing shot as a `<video>` (the path is in the manifest attempts), labelled "not shipped:
    failed the word-for-word check";
  - the already-finished shots' clips;
  - the Continue button with its estimate;
  - one line: "The agent never ships a video whose words differ from the line; this is that check working."
- Redo progress streams like a run (same SSE), and the manifest `redos` list (F19) grows.

### 3. Real ASR regression set (gate)
- `tests/fixtures/asr-live.jsonl` (given; 11 rows) holds real Whisper outputs from live runs on the server. Each row
  is `{ source, kind: "line"|"silent", expected, heard, verdict: "pass"|"hallucination" }`.
- Add rows mined from `docs/ai-log.md` and the earlier manifests (`examples/*.manifest.json`: `verbatim.heard`,
  attempt reasons) where a real heard text and its truth are recorded. Truth comes from what the log says a human
  verified. Mark every added row's `source`.
- Add `tests/fixtures/asr-tricky.jsonl`: hand-written but realistic Whisper renderings. There are at least 30
  must-pass and 15 must-fail rows across:
  - money: "$4.50", "€20", "£3.99";
  - years: "1987", "2005";
  - times: "3:15 a.m.";
  - percentages, ordinals, "24/7";
  - city transliterations;
  - US/UK spelling;
  - 's vs s;
  - contractions ("we'll"/"well" must fail);
  - number words vs digits ("thirty-eight"/"38");
  - same-sound number words only inside digit spans;
  - a dropped or added real word (must fail);
  - hyphenation ("well-known"/"well known");
  - "okay"/"OK";
  - "Mr."/"Mister";
  - em-dash and ellipsis punctuation.

  Each row has a one-line `why`.
- `tests/asr-corpus.test.ts`:
  - every `line` row's verdict matches `compareLine(expected, heard).pass`;
  - every `silent` row is recognised as speech heard in a silent shot (the existing listen/mute path);
  - on mismatch, the failure message prints the row's source and ops.
- `scripts/asr-corpus.ts` (run as `pnpm asr:harvest`) appends new `{expected, heard}` pairs from `runs/*/trace.jsonl`
  ASR spans (real providers only; `--from <dir>` for the server's runs). It writes `verdict: "unlabelled"`, which the
  test skips with a count, so a human labels them. It never prints keys or env.

### 4. Proven example ideas (web)
- The example chips list only ideas that have passed live, each with a "verified live" mark and the link to its
  example video (`/media/examples/...`):
  - **Train storyboard:** the 07 idea;
  - **Castle dialogue:** the 06 idea;
  - **Mother and son:** 02;
  - **Watchmaker numbers:** 03.

  Order: train first. The ideas are read from the example manifests at server start (not hardcoded), so the
  chips can't drift from what really passed.

## Acceptance
1. Unit tests for `explainFailure` on the real failures. `tests/fixtures/live-manifests/` holds both runs as they are
   now (both were rescued by `--redo`, so `ok: true`). The test builds each failed state: attempts up to and including
   the failing one, `status: "failed"`, `ok: false`, plus the run's error. For a20fab the failing attempt is the
   `voiceover` "speech ends at 10.42 s" one, with error "shot s2: the verified voice (10.42 s of speech) is longer
   than the 9.09 s clip; lengthen the shot or shorten the line". Also add a verbatim-only variant that ends at the
   second failed s2 `video` attempt ("sub four heard as for, ins dollars"). The tests check kind, step `shot`,
   shotId `s2`, and a diff marking "for"/"dollars".
2. Web tests:
   - `POST /api/runs/:id/continue`:
     - spawns the runner with `--resume <id> --redo shot`;
     - adds `--fresh-takes` when the gate version is current;
     - returns 409 while active and 400 for a done run.
   - The run detail API returns `failure` (the explanation) for failed runs.
3. `npx vitest run tests/asr-corpus.test.ts` passes. Both corpora are loaded. The counts are printed: rows per kind and
   unlabelled skipped.
4. A mock run made to fail on verbatim (MockVideo fault on every take) shows the explanation via the API. A continue
   with the fault removed finishes `done`, with `redos.length === 1`.
5. `pnpm verify` green; F01–F19 tests still pass.
