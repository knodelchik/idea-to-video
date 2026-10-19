# Progress

Append-only log, one entry per feature, written by the implementer agent and committed by the harness.

## F01 — Contracts and the verbatim gate
- `src/schemas.ts`: Zod schemas + inferred types for `Character`, `Shot`, `Script`, `Transcript`, `VerbatimResult`,
  `Attempt`, `FinalVideo`, `RunManifest`. `Script` enforces 1–2 shots (ids `s1`,`s2`), shots 3–10 s, a total of 8–30 s
  and at least one non-blank line.
- `formatIssues(zodError)` turns a failed parse into `path: message` lines, ready to feed back to a model as the retry reason.
- `src/verbatim.ts`: `normalize(text)` (NFKC, case, apostrophes, dashes, punctuation, numbers/times/ordinals → words;
  spoken symbols spelled out: `& % + = @ °`, `$N`/`€N`/`£N`, `-5` → "minus five"; any other symbol kept as its own token, never dropped),
  `compareWords(expected, heard)` returns `{ wer, ops, pass }`, and `pass` is true only at wer 0.
  `extractQuotedLines(idea)` handles `"…"`, `“…”`, `«…»` and `„…“`.
- Usage: `compareWords(shot.line, transcript.text).pass` is the gate; `ops` says exactly which words differ.
- Tests: `tests/verbatim.test.ts`, `tests/schemas.test.ts`.

## F02 — Provider interfaces, mocks, media toolkit, cache
- `src/providers/types.ts`: `LlmProvider`, `TtsProvider`, `AsrProvider`, `ImageProvider`, `VideoProvider`
  (`capabilities { nativeSpeech, durations }`), `LipsyncProvider`, `TalkingProvider`, and the `Providers` bundle.
  Every result has a `costUsd`. `generateJson` returns `{ ok, data | error, raw, costUsd }` and does not throw on a
  bad shape.
- `createProviders({ mode: "mock", env, overrides })` from `src/providers/index.ts` (the only import door for nodes)
  gives zero-cost ffmpeg mocks. `mode: "live"` throws `NotConfiguredError` naming the missing env var.
- Mocks (`src/providers/mock.ts`): TTS writes a tone wav (0.38 s/word + 0.3 s) and a `.transcript.json` sidecar;
  ASR reads it back. Faults: `new MockAsr({ faults: [{ call, drop | replace | text }] })` and
  `new MockVideo({ faults: [{ call, say }] })`. `MockLlm({ queue })` or `MockLlm({ responder })` records `calls`.
  After muxing speech yourself, call `linkSource(out, source)` (`src/util/sidecar.ts`) so the mock ASR can hear it.
  Lipsync/talking accept such linked audio too. Audio without a sidecar yields a silent output and does not throw.
- Media: `run(args)` and `probe(path)` in `src/media/ffmpeg.ts`. Pure builders in `src/media/args.ts`:
  `normalizeClipArgs`, `muxArgs`, `concatArgs`, `loudnormArgs`, plus `colorImageArgs`, `stillVideoArgs` and
  `toneArgs` for the mocks. Everything comes out 1080×1920 / 30 fps / yuv420p with an exact frame count.
- Cache: `contentKey(...parts)` (strings or `{ file }` hashed by contents) → 16 hex chars.
  `once(out, tmp => …)` returns `{ path, cached, result? }`. It writes atomically, moves sidecars along, cleans up
  after a crash, and dedupes concurrent calls.
- Tests: `tests/media.test.ts`, `tests/providers.mock.test.ts`. Both include real ffmpeg round-trips and take about 3 s.

## F03 — Script writer with deterministic validation
- `writeScript(idea, { llm, maxAttempts = 3 })` (`src/nodes/script.ts`) → `{ script, attempts }`. It asks the LLM for a
  `ScriptDraft`, adds `promptVersion` + code-extracted `quotedLines`, and re-prompts with the previous JSON and the
  problem list. After the last failure it throws `ScriptError { problems, attempts }`.
- `scriptProblems(script, idea)`: exact quoted lines, `quotedLines`, 1–2 shots with ids s1/s2, total 8–30 s,
  `wordCount/2.6 + 0.8 ≤ seconds`, no digits in non-quoted lines, `character.look` ≥ 12 words. One fix-oriented message each.
- Prompt: `src/prompts/script.ts` (`SCRIPT_PROMPT_VERSION`, `SCRIPT_SYSTEM`, `firstPrompt`, `retryPrompt`).
- Live LLM: `GeminiLlm` (`src/providers/gemini.ts`), `GeminiLlm.fromEnv(env)` reads `GEMINI_API_KEY` and `SCRIPT_MODELS`
  (comma list; 429/503 → next model, recorded in `LlmResult.notes`). `createProviders({ mode: "live" })` uses it for `llm`.
- `wordCount(text)` in `src/verbatim.ts` counts spoken (normalised) words.
- Tests: `tests/script.test.ts` (MockLlm + a fake Gemini client; no network).

## F04 — Verbatim gate on speech, with a fallback voice
- `listen(path, expected, { asr })` (`src/nodes/gate.ts`) → `VerbatimResult` + `speechStart`/`speechEnd` (from ASR word
  timestamps) + `transcript` + `costUsd`. Works on audio or video. Delivery tags in `expected` are stripped first.
  `describeOps(ops)` makes the retry reason; `VerbatimError { result, attempts }` is thrown when retries run out.
- `verifiedVoice(line, character, { tts, asr, dir, maxAttempts = 3, emotion?, shotId? })` (`src/nodes/voice.ts`) → a
  `VoiceTrack` (`path, seconds, speechStart, speechEnd, verbatim`) + `attempts` (`stage: "voice"`; a failed attempt
  lists its diff ops). Takes are content-addressed (`dir/voice-<key>.wav`) and reused on resume.
- Emotion goes in `TtsRequest.emotion` and never into the words: `splitDelivery(line)` (`src/verbatim.ts`) separates
  `[tags]`/`<tags>` from the spoken text.
- Live adapters (fake-fetch tested): `GroqAsr` (Whisper verbose_json, word timestamps, `GROQ_API_KEY`, `GROQ_ASR_MODEL`),
  `GeminiTts` (Interactions API, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICES`) and `ElevenLabsTts` (`eleven_v3`, `[tag]`
  prefix, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICES`). `ttsFromEnv` builds a `TtsChain` in `TTS_PROVIDERS` order
  (default `gemini,elevenlabs`; providers without a key are skipped; 429/5xx fall back and are recorded in `notes`).
- `createProviders({ mode: "live" })` now wires `tts` and `asr`. Helpers: `pcmToWav`/`wavSeconds`
  (`src/providers/http.ts`) and `extractAudioArgs` (`src/media/args.ts`).
- Tests: `tests/voice.test.ts` (26 tests: mock ffmpeg round-trips and adapter requests; no network).

## F05 — Visuals: identity anchor, keyframes, talking shots (Seedance 2.0)
- `Shot.seconds` is 4–15 (total still 8–30). The script prompt reads the range from the schema (`script-v2`).
- `src/nodes/visuals.ts`:
  - `castCharacter(script, { image, dir })` and `keyframeShot(shot, script, portrait, prev?, { image, dir })` return
    `{ path, attempts }`. A keyframe's refs are `[portrait, prev?]`.
  - `talkingShot(shot, keyframe, { script, video, asr, tts, lipsync, dir, maxNative = 2 })` returns
    `{ path, seconds, via: silent|native|lipsync, verbatim, speechStart/End, attempts }`. It tries native speech
    (gated) up to `maxNative` times, then falls back to `verifiedVoice` + lip-sync + gate.
  - All artifacts are content-addressed.
- Pure helpers:
  - `snapDuration(seconds, durations)`;
  - `portraitPrompt`, `keyframePrompt`, `talkingPrompt` in `src/prompts/visuals.ts` (the line is quoted verbatim;
    delivery tags go into the emotion).
- Errors:
  - `PolicyRejectedError` (`src/providers/errors.ts`) is never retried. The node throws
    `ShotError { shotId, attempts, cause }`.
  - A lip-synced clip that still fails the gate throws `VerbatimError`.
- Live adapters (fake-tested, no network):
  - `SeedanceVideo` with `SEEDANCE_TRANSPORT=fal` (`FAL_KEY`, `SEEDANCE_TIER=fast`) or `byteplus` (`ARK_API_KEY`,
    `SEEDANCE_MODEL`, `ARK_BASE_URL`; field names UNVERIFIED);
  - `imageFromEnv`: `IMAGE_PROVIDER=fal-nano-banana|gemini|seedream`;
  - `lipsyncFromEnv`: `LIPSYNC_PROVIDER=fal-kling|command`, with `LIPSYNC_CMD` containing `{video} {audio} {out}`.
  - `createProviders("live")` wires all three. `talking` still needs an override.
- Mocks: `calls[]` logs on `MockImage`, `MockVideo`, `MockTts` and `MockLipsync`; `VideoFault.reject` throws
  `PolicyRejectedError`. Tests: `tests/visuals.test.ts` (32 tests).
- A shot's `seconds`/`hasAudio` are always ffprobe-measured on the delivered file: the Seedance download, every
  node clip and the lip-synced output. Adapters supply only `costUsd`.
- The test fake for fal storage returns content-hashed URLs (`upUrl(path)` in `tests/visuals.test.ts`), so tests with
  parallel uploads are deterministic. Use byte-different files when a test checks upload order.

## F05 — Visuals: post-BLOCKED fixes (lip-sync limits, failure attempts)
- Every failure path of `talkingShot` now throws `ShotError` (or `VerbatimError` for a non-verbatim lip-synced
  clip) carrying the full attempt list. ASR errors, lip-sync errors and unexpected errors are recorded as failed
  attempts, with their cost, before the throw.
- `LipsyncProvider.maxSeconds` is now required:
  - Kling: 10;
  - `command`: `Infinity`, or set it with `LIPSYNC_MAX_SECONDS`;
  - `new MockLipsync({ maxSeconds })` rejects longer inputs, like the real API.
- A base clip longer than `maxSeconds` is trimmed to `voice.speechEnd + 0.4` s with `trimArgs` (`src/media/args.ts`)
  and recorded as a `trim` attempt. If even that doesn't fit, a failed `trim` attempt is recorded and a readable
  `ShotError` is thrown; speech is never silently cut.
- `tests/visuals.test.ts` now has 38 tests; `pnpm verify` passes 162 tests.

## F05 — Visuals: silent native takes
- A native clip with no audio stream (ffprobe `hasAudio: false`) is recorded as a failed `video` attempt with
  reason `no audio track`. It is never sent to ASR, and the next take is tried.
- If every native take is silent, the shot falls back to verified TTS + lip-sync on the first silent clip. The
  fallback attempt says "no take had an audio track".
- Tests: `StrictAsr` in `tests/visuals.test.ts` throws on silent input like live Groq; `MockVideo` faults with
  `say: ""` produce silent clips. 40 visuals tests, 164 total in `pnpm verify`.

## F06 — Graph, assembly, final gate, one command
- `pnpm make "<idea>" [--mock|--live] [--resume <runId>] [--json]` (`src/cli.ts`, default `--mock`) writes
  `runs/<runId>/final.mp4` and `runs/<runId>/manifest.json`. `--json` prints one last line
  `{ ok, runId, finalPath, seconds, verbatim: { wer, expected, heard }, costUsd, attempts, manifest }`.
  Exits 0 only when ok. In-process: `main(argv, { runsDir, env, overrides, retry, beforeNode })`.
- `src/graph.ts`: LangGraph `writeScript → cast → drawKeyframes → shot (Send per shot) → assemble → finalGate`,
  checkpointed in `runs/checkpoints.sqlite` (`thread_id = runId`). `runPipeline(req, deps)` returns
  `{ manifest, manifestPath }`. `--resume` skips finished stages without calling their providers.
  Transient errors (`isTransient`, walks `.cause`) are retried with backoff and recorded as `stage:"retry"`
  attempts. Any other failure gives `ok:false` and a readable `error`.
- `src/nodes/assemble.ts`: each shot is cut to `max(script s, speechEnd + 0.4)`, capped at the clip length, and
  normalised to 1080×1920/30 fps (silent shots get generated silence). 50 ms audio fades at the joins, concat,
  then two-pass loudnorm to −16 LUFS. `src/nodes/final-gate.ts` probes for 8–30 s, 1080×1920 and an audio track,
  and listens to the whole file against every line joined.
- Budget: `MAX_COST_USD` (default 3). `withBudget` (`src/providers/budget.ts`) refuses any call whose
  `estimateUsd` would exceed it, before calling. Every live adapter now has `estimateUsd`. `--live` prints the
  estimated cost of a typical run first.
- Mocks: `createProviders("mock")` uses `mockScriptResponder`, so any idea runs. `linkSources(media, [{source,
  offset, until}])` (`src/util/sidecar.ts`) lets the mock ASR hear cut and concatenated files. `RunManifest` now
  has `shots` and `spoken`.
- Tests: `tests/graph.test.ts` (25 tests: the acceptance idea, crash + resume with call counters, final-file
  mishearing, transient vs permanent video errors, budget abort before the first paid call). `pnpm verify` passes
  189 tests, and its mock e2e step is now active. `.env.example` was not updated (see the spec's Blocked note).

## F07 — Quality judge and regeneration
- `JudgeProvider` (`judgeImage` / `judgeVideo` → `{ score 1–10, issues[], costUsd }`, checked against `JudgeVerdict`).
  Live: `GeminiJudge` (`JUDGE_MODELS`, Gemini vision, structured output). Mock: `new MockJudge({ image: [4, 8],
  video: [...], fallback })`. A script entry is a score, `{score, issues}` or `{ raw }`, and `raw` is schema-checked
  like a live reply. A bad reply throws `JudgeOutputError` (it carries its cost) and is recorded as an unscored
  judge failure, never a pass.
- `src/nodes/quality.ts`:
  - `judgedKeyframe` redraws while the score is below `KEYFRAME_MIN` (7), at most 2 extra times, with the issues
    appended to the prompt (`withIssues`, `src/prompts/judge.ts`).
  - `judgedTalkingShot` judges 3 frames against the portrait. Below `CLIP_MIN` (5) it runs one more `talkingShot`
    take, only if `Budget.allows(regenEstimateUsd(...))`. Otherwise it records a `regen` attempt with
    `provider: "budget"`.
  - When nothing passes, the best take is kept and the shot gets `needsReview: true`.
- The manifest has `stage: "judge"` attempts with `score`, plus `shots.sN.{keyframeScore, clipScore, needsReview}`.
  Verdicts are cached as `runs/<id>/judge-*.json`, so a resume doesn't pay to judge again.
- `src/media/frames.ts`: `frameTimes`, `frameArgs` (pure) and `extractFrames(clip, n, dir)`.
- Settings: `KEYFRAME_MIN`, `CLIP_MIN` and `JUDGE_MODELS` (`.env.example`). Tests: `tests/judge.test.ts`
  (21 tests). `pnpm verify` passes 210 tests.

## F08 — Eval set and regression runs
- `evals/ideas.jsonl` has 10 ideas. Seven quote a line: contractions, "3 a.m.", a name, a question, an
  exclamation, curly quotes with an em dash, and a 15-word line. Three quote nothing.
- `npx tsx evals/run.ts --mock [--limit N] [--ids a,b] [--label x]` runs the ideas one at a time and writes
  `evals/results/<date>-<label>-<mode>.json`. The file has a row per idea plus aggregates: success rate, verbatim
  first-try/final pass rates, mean attempts per stage, judge mean/min, duration, cost per video/success, stage and
  wall-time p50/p90, needs-review rate, and the human rating mean. It also prints a table. A human runs the live
  mode with `pnpm eval` (it loads `.env`).
- `npx tsx evals/compare.ts a.json b.json` prints a per-metric delta table and exits 1 on a regression: verbatim
  or success rate down, cost per video up more than 20%, or judge mean down more than 0.5.
- People rate videos by filling `human` (1–5, "would you keep watching") per idea in the results file. `compare`
  recomputes the aggregates, so those ratings count.
- The pure logic is in `evals/metrics.ts`, and the metric definitions are in `evals/README.md`. Tests:
  `tests/evals.test.ts` (20). `pnpm verify` passes 230 tests.

## F09 — Model benchmark
- `npx tsx scripts/bench.ts --mock|--live [--models id,id] [--line "..."] [--yes]` runs every model in the
  registry, in the order given, on the same inputs:
  - a portrait close-up keyframe;
  - an ASR-verified TTS line.

  Both are cached in `runs/bench/`, and so are the clips: a re-run doesn't pay again.
- Paths:
  - native: i2v with the line in the prompt, no lip-sync;
  - lipsync: silent i2v, then `LIPSYNC_PROVIDER`;
  - talking: keyframe + voice.

  Each row has its registry cost, reported cost, wall time, the clip audio's WER, the F07 clip judge score, and the
  output path. A model that fails is a `FAILED:` row, not a crash.
- Outputs:
  - Live: `docs/bench/<date>.md` (`-2`, `-3`… instead of overwriting). Mock: `<date>-mock.md` (gitignored).
  - The table has an empty `notes` column for the human.
  - `<same>-grid.mp4` is a silent `xstack` grid in table order. Cell k has k white squares top-left.
- Live always prints the plan and the estimated total first. Without `--yes`, it exits 1 before building any provider.
  It also refuses an estimate over `MAX_COST_USD`. Paid calls go through one `Budget`.
- The registry is in `src/bench/registry.ts`: seedance-2.0, seedance-2.0-fast, seedance-2.0+lipsync,
  kling-avatar-v2 and kling-avatar-v2-pro. The new live adapter `FalKlingAvatar` / `klingAvatarFromEnv` is in
  `src/providers/talking.ts`. To add a model, add an adapter and a registry entry.
- Tests: `tests/bench.test.ts` (20) covers args, the cost plan, the grid args, the report, the live gate, mock end to
  end with a failing model and a mishearing ASR, and the avatar adapter with a fake fal. `pnpm verify` passes 250
  tests.

## F10 — Hard lines: fair verbatim gate, fail before paying
- The gate accepts the same spoken words in any spelling and still fails a missing, added or changed word:
  - numbers, times and money have several readings (`1987` = "nineteen eighty seven" | cardinal; `$4.50` =
    "four fifty" | "four dollars (and) fifty cents"; `3.15 AM` = `3:15 a.m.`; `24/7`);
  - diacritics are folded and `Dr./Mr./Mrs./Ms.` are spelled out;
  - dotted/hyphenated initialisms are joined (`F.B.I.`/`F-B-I` → `fbi`, `a.m.` → `am`). Spaced letters (`f b i`)
    are never merged, but `fbi` is one of their readings, so `a.m. I` = `AM I` and `F.B.I. I` = `FBI I`;
  - `compareWords` passes iff some pair of readings is identical (cap `MAX_READINGS = 32` per side).
- `compareLine(line, heard)` is the gate's view of a script line:
  - delivery tags and emoji (`splitDelivery(...).emoji`) are not expected words;
  - heard `[…]`/`(…)` and `*action*` are dropped. Only known non-speech actions (`*sighs*`, `*laughs softly*`)
    count as `*…*` tags; `I *really* mean it.` keeps "really" as a spoken word;
  - private-use characters (e.g. the Apple logo) are never words and can't collide with span placeholders;
  - a `[laughs]` line ignores inserted `ha/haha/heh`;
  - everything dropped goes to `VerbatimResult.ignored` and into the attempt reason.
- Pre-spend checks (`preSpendProblems`, `IdeaRejectedError`) reject an idea before any model call, with a $0
  `pre-spend-check` attempt in the manifest:
  - non-English (non-Latin) lines;
  - nested double quotes (`QuoteError`);
  - a quote over 15 s;
  - quotes that can't fit 2 × 15 s.
- One shot line may hold several quotes in idea order with nothing added (prompt `script-v3`), so three short lines
  fit in two shots. Lines longer than the lip-sync limit are noted on the script attempt ("no lip-sync fallback for
  this line").
- Mocks: the mock writer sizes shots by spoken words, and MockAsr hears only speakable tokens.
- `npx tsx evals/run.ts --mock --set hard` runs `evals/hard.jsonl`. Rejected ideas show as `rejected: true`.
- Every model in both Gemini default chains has a price (tested).

## F11 — Two speakers, and prompts written the way Seedance 2.0 documents them
- Contract: `Script.characters` (1–2 entries, unique names, each with a `voiceDescription`) and
  `Shot.speaker` / `Shot.onScreen`. The rules live in `castProblems`. Old single-`character` scripts and manifests
  still parse: `migrateScript` runs inside `Script`. Helpers: `speakerOf(script, shot)`, and `castOf`, which lists
  the speaker first.
- `src/speakers.ts` → `quoteSpeakers(idea)` reads who says each quoted line. `scriptProblems` rejects:
  - one character for two attributed speakers;
  - one character saying lines that belong to different people;
  - a she/he line given to the wrong voice gender.

  `preSpendProblems` rejects more than 2 speaker turns for $0. A leading subordinate clause ("As she opens the
  door, her husband asks") is ignored when finding the speaker.
- Visuals: `castCharacters(script)` → `{ portraits: { name: path } }`. `keyframeShot`, `talkingShot({ portrait })` and
  `judgedKeyframe` take that map, or a single path for one character. In refs mode the refs are the speaker's
  portrait, then the others, then the keyframe. The judge compares the clip with the speaker's portrait.
- Prompts `visuals-v3` (`src/prompts/visuals.ts`):
  - starts with the audio policy;
  - `Voice: …`, then `Name … says in English: {line}` with nothing after the brace;
  - `@Image N (Name)` / `@Image N (opening frame)` refs;
  - judge issues, then the constraint tail last.

  Script prompt `script-v4`: 1–2 characters, one speaker per spoken shot, shot-reverse-shot.
- Assembly adds a 200 ms end fade-out per segment (`END_FADE`, `segmentArgs({ endFade })`).
- Try it: `npx tsx src/cli.ts 'At the kitchen table, a mother slides an envelope to her son. She says: "Open it after I leave." He looks up and asks: "Mom, are you sick?"' --mock --json`.
  The mock writer makes Alex (she) and Sam (he), one line each.
- Attempt 2: speaker attribution also reads trailing tags (`"…," she says.`, `"…?" asks her son.`), pronouns after
  connectives ("Then she adds") and possessive subjects ("The bride's father" → male). Try:
  `pnpm make 'A mother slides an envelope to her son. "Open it after I leave," she says. "Mom, are you sick?" he asks.' --mock`
  → Alex (she) says line 1, Sam (he) says line 2.

## F12 — Wide shots and storyboard ideas
- Shot sizes: `Shot.camera` is one of `extreme wide shot | wide shot | full shot | medium shot | medium close-up |
  close-up` (old `"medium"` migrates). `isWide()` is true for the first three. A script has up to 4 shots (`s1`–`s4`).
- Storyboards: `parseStoryboard(idea)` in `src/storyboard.ts` splits `1 кадр: … 2 кадр: …`, `Shot 1: …`, `1. …` and
  `1) …` into 2–4 beats. It ignores ordinary numbers and numbers inside quotes. 5+ beats are rejected before any
  paid call.
  - The script must have one shot per beat, and a quote in beat k must be in shot k (`scriptProblems`).
  - Pre-spend also rejects a beat with two speakers, a beat whose quotes need more than 15 s, and beats that can't
    fit 30 s.
- Prompts:
  - `script-v5` has shot-size rules and asks for looks that read at a distance.
  - `visuals-v4`: on a wide shot the character is "small in frame … recognisable by <look>; the place dominates", and
    the line is `Name, small in frame, says in English: {line}`.
  - `judge-v3` judges wide shots on recognisability, whole figures and stable architecture, with no lip-sync item.
- Wide-shot fallback: when native speech fails on a wide shot, the verified TTS is laid over the clip with no
  lip-sync call. The manifest shows `audio: "voiceover"`, stage `voiceover`, and the reason on the `fallback`
  attempt. Close sizes still use TTS + lip-sync.
- Try:
  `npx tsx src/cli.ts '1 кадр: маленька дівчина в червоному плащі відчиняє величезні двері старого замку. 2 кадр: вона заходить у величезну бальну залу, зала видна вся, дівчина маленька на її фоні, і каже: "Hello? Is anyone still here?"' --mock --json`
  → 2 shots, both wide, the line on s2, WER 0. `npx tsx evals/run.ts --mock --set hard --label f12` runs the three
  new eval ideas.

## F13 — Burned-in subtitles of the verified line, and cuts inside a clip
- Every final video has white bold subtitles burned into the lower third. The text is the expected line, never ASR
  text, in 2–6 word cues (no 1-word cue, even after a lone "Yes,") timed by ASR word timestamps (numbers align, e.g. "1987" ↔ "nineteen eighty-seven"). The
  manifest has `subtitles: { file, cues, timing }`.
- Turn them off with `--no-subtitles` or `SUBTITLES=0`. The final gate always listens to the file that is shipped.
- Cue cards are transparent PNGs rendered by `@resvg/resvg-js` (`src/media/subtitle-card.ts`) and overlaid with
  `overlay=enable='gte(t,a)*lt(t,b)'` (`overlayCuesArgs`; half-open, so abutting cues never share a frame),
  because this ffmpeg has no drawtext/libass.
- `Shot.cuts` (2–3 cuts, shot ≥ 6 s) renders in one Seedance call as `Shot 1: … Shot 2: …` with the line said once
  after the list (`visuals-v6`, `script-v7`, `judge-v5`). If native speech fails on a cut shot, the verified TTS is
  laid over the clip as a voice-over, with no lip-sync.
- The keyframe of a cut shot is the opening cut: `openingCastOf` / `keyframePortraits` give its cast (speaker first
  if in it) to the keyframe prompt, the keyframe rubric and both sets of refs. The video call still gets every
  on-screen portrait. A first cut with `onScreen: []` is rejected; inserts only as cut 2 or 3.
- Try: `npx tsx src/cli.ts 'A tired barista finds a note in the tip jar: "Meet me where it started."' --mock --json`,
  then the same with `--no-subtitles`, and compare the lower third.

## F14 — The clip judge watches the video, not 3 frames
- `judgedTalkingShot` sends the clip itself to the judge (`JudgeVideoRequest.video` + `seconds`). The 3 extracted
  frames still go along as the fallback. `MockJudge.calls` records `video`.
- `GeminiJudge.judgeVideo` sends one inline `video/mp4` part with `videoMetadata.fps = 4`, plus the portrait. If
  the clip is over 18 MB, or Gemini returns a 400 naming the video, it judges the frames instead and puts why in
  the verdict notes, so the reason reaches the attempt in the manifest.
- `estimateUsd({ …, videoSeconds })` prices video at 258 tokens per sampled frame plus 32 per second of audio. The
  budget guard and `regenEstimateUsd` reserve the dearer of the video and frames paths.
- Rubric `judge-v7`: `clipRubric(shot, script, { video: true })` says "Watch this vertical video clip", keeps the
  v6 camera-move and action-match rules, and tells the judge not to score the words. The bench keeps the frames
  wording.
- The cached clip verdict is keyed by the clip's bytes and name, the rubric and the judge prompt version, so a
  resumed run doesn't pay to re-judge a take.

## F16 — Observability: a trace of every model call, and metrics across runs
- Every run writes `runs/<id>/trace.jsonl`: one span per provider call (llm / image / video / tts / asr / judge /
  lipsync) holding the full prompt or rubric, media as path + sha256, the reply text (capped at 4 kB), finish reason,
  usage, cost, ms and error. There is also one `node` span per graph node, which is the parent of its calls. Shot spans
  carry `shotId`. A resume or `--redo` appends to the file, and reused artifacts show up as `cached: true`, $0.
- Code: `src/obs/trace.ts` (span type, ALS context, `JsonlSink`), `src/obs/with-trace.ts` (`withTrace(providers,
  sink)`, wrapped inside `withBudget`). `once(out, fn, { kind, provider, request })` traces cache hits. Gemini fills
  `meta` (`finishReason`, `promptFeedback`, usage, raw text), including on a `JudgeOutputError`, so an empty judge
  reply shows why.
- `pnpm metrics [runsDir] [--json]` prints metrics across runs: success, first-take verbatim, WER=0, $ per
  (successful) video, p50/p90 wall time per stage and run, attempts per stage, real-face refusals and ladder rungs,
  TTS / lip-sync / voice-over shots, silent-shot speech dropped, ASR words ignored in silence, the judge score
  histogram, failures and needs-review rate, model calls by provider/model with tokens and $, and top failure
  reasons. Pure core in `src/obs/metrics.ts`; evals reuse `percentile` and `verbatimFirstTake`.
- Optional Langfuse: set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (and optionally `LANGFUSE_HOST`, default EU
  cloud). At run end there is one OTLP/JSON POST to `/api/public/otel/v1/traces`: a root run span, node spans, and
  generations with model, usage and cost. A failed export is logged and lands in the manifest's new `notes`, and the
  run stays ok.
- Env values named `*_KEY` / `*_SECRET` / `*_TOKEN` are redacted from trace lines before writing.

## F15 — A small hosted web demo behind one access code
- `ACCESS_CODE=… SESSION_SECRET=… pnpm web` serves `src/web/` on `PORT` (8080). Login takes one code (5 wrong per IP
  per 15 min → 429) and sets a 7-day HttpOnly/Secure/SameSite=Lax HMAC cookie. Then: Make (form + 3 example ideas,
  Mock/Live switch; live only with `WEB_LIVE=1`), Gallery (runs + `examples/`, inspector with video, script, shots,
  verbatim, fallback ladder, subtitles, every attempt, totals, and a Trace tab) and Metrics (F16).
- API: `POST /api/runs {idea, mode}` → 202 `{runId}` (one run at a time, else 409); `GET /api/runs`,
  `/api/runs/:id`, `/api/runs/:id/events` (SSE: `attempt`, `progress`, `done`), `/api/runs/:id/trace`,
  `/api/metrics`, `/api/config`, `/media/<id>/final.mp4` and `/media/examples/<file>.mp4` with Range, `/health`.
- Runs are `node --import tsx src/cli.ts --<mode> --json --run-id <id> -- <idea>` children (no shell) with
  `MAX_COST_USD` and `RUNS_DIR` in env. The CLI gained `--run-id`, `--` (end of flags) and `RUNS_DIR`.
- Tests inject `createWebServer(cfg, { startRun })`, a fake runner that writes manifests over time.
  `tests/web.test.ts` also drives one real mock run end to end and ffprobes the served `final.mp4`.
- Deploy: `deploy/Dockerfile` (node:22-bookworm-slim, ffmpeg, pnpm via corepack, `.env` guard), root
  `.dockerignore`, `deploy/docker-compose.yml` (`itv-web` on the external `coolify` network, Traefik labels,
  `TRUST_PROXY=1`) and `deploy/README.md` (env, `tar | ssh`, build/start, the nightly image prune).
