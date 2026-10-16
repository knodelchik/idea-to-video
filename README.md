# idea-to-video

One command: you give a 1–3 sentence idea, and you get back a vertical 8–30 s video in which a character says the line
**word for word**. "Word for word" is checked by code: speech-to-text runs on the finished file, and the run fails if
a single word differs.

```sh
pnpm make 'A tired barista finds a note in the tip jar: "Meet me where it started."'
# → runs/<runId>/final.mp4  +  runs/<runId>/manifest.json (every attempt, every cent)
```

## Quick start (free, no keys)

Requires Node ≥ 22, pnpm, and ffmpeg/ffprobe on `PATH`.

```sh
pnpm install
pnpm make 'A tired barista finds a note in the tip jar: "Meet me where it started."'   # mock mode, $0
pnpm verify                                                                             # typecheck + 250 tests + mock e2e
```

Mock mode runs the whole graph with local ffmpeg stand-ins for every model. Mock audio and video carry transcript
sidecars, so the verbatim gate, retries, fallbacks and resume can all be tested without paying for anything. Mock
output is test patterns, not a film.

## Live run

```sh
cp .env.example .env                      # then fill in the keys below
pnpm preflight                            # no network: prints the exact requests and which keys are set
pnpm make "<idea>" --live                 # prints the cost estimate first; MAX_COST_USD caps the run
pnpm make --resume <runId>                # continue a crashed or interrupted run from its checkpoint
pnpm make "<idea>" --live --json          # last stdout line: { ok, runId, finalPath, seconds, verbatim, costUsd, attempts }
```

| Key | Used for | Needed? |
| --- | --- | --- |
| `GEMINI_API_KEY` | script writer, quality judge, fallback TTS, images if `IMAGE_PROVIDER=gemini` | yes (free tier works) |
| `GROQ_API_KEY` | Whisper ASR for the verbatim gate | yes (free tier works) |
| `FAL_KEY` **or** `ARK_API_KEY` | Seedance 2.0 video (fal or BytePlus ModelArk, `SEEDANCE_TRANSPORT`), Seedream / Nano Banana images, Kling lip-sync fallback | yes, one of them |
| `ELEVENLABS_API_KEY` | second fallback TTS engine | optional |
| `LIPSYNC_CMD` | a local open-source lip-sync model (e.g. LatentSync) instead of fal Kling | optional |

All settings are listed with comments in [.env.example](.env.example). `MAX_COST_USD` (default 3) is checked
**before every paid call**, retries included, so a retry loop can't run past it.

## How it works

```
idea ─► writeScript ─► cast ─► drawKeyframes ─► shot (one per shot, parallel) ─► assemble ─► finalGate ─► final.mp4
        LLM, Zod-      portrait  keyframes      Seedance 2.0 i2v, line spoken     ffmpeg:      probe + ASR
        validated,     (image)   + VLM judge    natively → ASR gate → retry →     1080×1920,   of the final
        lines checked            (redraw on     fallback: verified TTS + lip-sync  loudnorm     file, WER = 0
        by code                  low score)     → VLM judge on the clip                         or the run fails
```

- **Graph:** LangGraph.js `StateGraph`. Shots fan out with `Send`. The state is checkpointed to SQLite after every
  step, so `--resume` re-runs only what didn't finish (paid clips are never regenerated).
- **Contracts:** each stage's output is a Zod schema in `src/schemas.ts`. LLM output that fails the schema is fed
  back to the model with the exact errors (max 3 tries).
- **Verbatim gate** (`src/verbatim.ts`): text is normalised (case, punctuation, numbers → words, `& $ %` spelled
  out) and compared token by token with Levenshtein. WER must be exactly 0. Quoted lines in the idea are extracted
  by code, never by the LLM.
- **Native speech first, fallback second:** Seedance 2.0 speaks the line from the prompt. If ASR hears a different
  line, it retries (`maxNative`). If that also fails, the line is synthesized by TTS, checked by ASR before use, and
  put on the clip by a lip-sync model. In that branch the audio is the source of truth.
- **Quality judge:** a VLM (Gemini) scores keyframes and clips against a rubric. A keyframe below 7 is redrawn with the
  judge's issues added to the prompt (max 2 extra). A clip below 5 is regenerated once, only if the budget allows.
  Otherwise the best take is kept and flagged `needsReview`.
- **Nothing silent:** every retry, fallback, judge score and cost goes into `manifest.attempts[]`.
- **Idempotent:** every generated file is content-addressed (`once()`), so a re-run with the same inputs costs $0.

## Measuring it

```sh
npx tsx evals/run.ts --mock --limit 3                  # 10 fixed ideas (numbers, names, curly quotes, a 15-word line…)
pnpm eval:compare evals/results/a.json evals/results/b.json   # exits 1 on a regression
npx tsx scripts/bench.ts --mock                        # same keyframe + line through several video models
```

See [evals/README.md](evals/README.md) for the metrics and which of them are automated and which are human.

## How this repo was built: an agent harness

The code in `src/` was written by Claude Code agents running headless, one feature at a time. I wrote the
specs, the gate and the reviewer, then debugged the harness itself.

```
specs/features.json ─► implementer agent (claude -p) ─► gate: scripts/verify.sh + the feature's acceptance commands
                                  ▲                                   │
                                  └── reviewer's issues ◄── reviewer agent (read-only, JSON verdict)
                                       (max 3 attempts, then BLOCKED → human)        │ pass
                                                                                      ▼
                                                                         harness commits feat(Fxx)
```

- `scripts/harness.sh` drives the loop. Logs go to `harness/runs.md`, decisions to each `specs/F*.md`, mistakes to
  `docs/ai-log.md`.
- An agent's own "done" is never trusted. The gate runs typecheck, the tests, import-boundary checks and a mock
  end-to-end run, and a separate reviewer agent must pass the change.
- Claude Code hooks (`.claude/hooks/`) stop agents from spending money (`--live`, paid API hosts), reading `.env`,
  editing the gate, or pushing. A Stop hook won't let an agent finish while `verify` is red.
- Result: 9 features, 15 implementer runs, 6 reviewer rejections (all real bugs), 1 feature BLOCKED and fixed by a
  human note in the spec.

## Repo map

| Path | What |
| --- | --- |
| `src/cli.ts`, `src/graph.ts` | the command and the LangGraph pipeline |
| `src/nodes/` | stages: script, visuals (keyframes, talking shot), voice, gate, quality, assemble, final gate |
| `src/providers/` | one interface per capability; live adapters + mocks; `index.ts` is the only import door |
| `src/schemas.ts`, `src/verbatim.ts` | contracts and the verbatim gate |
| `specs/` | the feature specs the agents built from, each with its Decisions section |
| `docs/research/` | model and tooling research with sources (VERIFIED / UNCERTAIN) |
| `docs/ai-log.md` | where AI got it wrong and how it was caught |
| `evals/`, `scripts/bench.ts` | eval set and model benchmark |

## Known limits

- English lines only. No major video model officially supports Ukrainian speech yet, and the ASR gate would need a
  per-language normaliser.
- Live adapters were checked against the providers' docs and request-shape tests. The pipeline was mostly
  developed against mocks, and only a handful of live runs were paid for (see `runs/` and the examples).
- Lip-sync fallback via fal Kling caps a lipsynced clip at `LIPSYNC_MAX_SECONDS` (10 s).
