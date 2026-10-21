# idea-to-video

One command: you give a 1–3 sentence idea, and you get back a vertical 8–30 s video in which a character says the line
**word for word**. "Word for word" is checked by code: speech-to-text runs on the finished file, and the run fails if
a single word differs.

```sh
pnpm make 'A tired barista finds a note in the tip jar: "Meet me where it started."'
# → runs/<runId>/final.mp4  +  runs/<runId>/manifest.json (every attempt, every cent)
```

## How to read this repo (10 minutes)

1. **This README:** what the pipeline does and how to run it.
2. **One spec, e.g. [`specs/F18-blocking-continuity.md`](specs/F18-blocking-continuity.md):** what an agent was
   given: the goal, the scope, and acceptance commands that a script can check. All 20 are in `specs/`.
3. **[`harness/runs.md`](harness/runs.md):** what the agents did with the specs: attempts, the gate, reviewer
   verdicts, BLOCKED features and the commit each one became.
4. **[`docs/ai-log.md`](docs/ai-log.md):** where AI got it wrong and how each mistake was caught.
5. **[`docs/ai-chats/`](docs/ai-chats/):** two full agent sessions, including a reviewer rejecting green code.

The rest is reference: `docs/research/` (model research with sources), `evals/`, `deploy/`, and
`harness/PROGRESS.md` (the agents' own per-feature notes).

## Quick start (free, no keys)

Requires Node ≥ 22, pnpm, and ffmpeg/ffprobe on `PATH`.

```sh
pnpm install
pnpm make 'A tired barista finds a note in the tip jar: "Meet me where it started."'   # mock mode, $0
pnpm verify                                                                             # typecheck + 570+ tests + mock e2e
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
pnpm make --resume <runId> --redo shot     # replay from a step; unchanged (paid) artifacts are reused for $0
pnpm make "<idea>" --live --json          # last stdout line: { ok, runId, finalPath, seconds, verbatim, costUsd, attempts }
```

| Key | Used for | Needed? |
| --- | --- | --- |
| `GEMINI_API_KEY` | script writer, quality judge, fallback TTS, images if `IMAGE_PROVIDER=gemini` | yes (free tier works) |
| `GROQ_API_KEY` | Whisper ASR for the verbatim gate | yes (free tier works) |
| `OPENROUTER_API_KEY` **or** `FAL_KEY` **or** `ARK_API_KEY` | Seedance 2.0 video (`SEEDANCE_TRANSPORT=openrouter\|fal\|byteplus`), Seedream / Nano Banana images (`IMAGE_PROVIDER`), Kling lip-sync fallback (fal) | yes, one of them; the examples were made via OpenRouter |
| `ELEVENLABS_API_KEY` | second fallback TTS engine | optional |
| `LIPSYNC_CMD` | a local open-source lip-sync model (e.g. LatentSync) instead of fal Kling | optional |

All settings are listed with comments in [.env.example](.env.example). `MAX_COST_USD` (default 3) is checked
**before every paid call**, retries included, so a retry loop can't run past it.

## Web demo and traces

- **Demo:** `https://itv.158-180-45-68.sslip.io`: one access code (sent with the submission), mock or live mode,
  `MAX_COST_USD=3` per live run, one run at a time. The page shows every model call live (Seedance, refusals, TTS,
  ASR, judge) with its cost, and keeps the timer across reloads. The example chips are ideas that already passed live.
- **If a run fails:** this usually means the agent *refused to ship*, not that it crashed. The failure page says why
  in plain words (e.g. "shot s2: heard *for fifty dollars*, the line says *$4.50*"), shows the shots already made and
  the take that failed, and offers **Continue** with a cost estimate. Continue resumes from the failed step; finished
  shots are reused for $0.
- **Traces:** every call is written to `runs/<id>/trace.jsonl` and, when `LANGFUSE_*` keys are set, to Langfuse
  (official SDK, verb-first span names, generation/agent/tool observation types, scores `verbatim_pass`,
  `verbatim_wer`, `needs_review`, `cost_usd`). The demo's Langfuse is self-hosted on the same VPS.
- Deploy: `deploy/` (Docker Compose behind Traefik).

## Examples

Made with the live pipeline (OpenRouter Seedance 2.0 fast); the manifest next to each file has every attempt and cost.

| File | Idea | Length | Cost |
| --- | --- | --- | --- |
| `examples/08-astronaut-plain-idea.mp4` | A plain one-sentence idea, no shot list: the script split it into a wide shot and a close-up with the line. Seedance refused the close-up twice as a possible real person; the ladder passed it on the portrait alone ($0). Subtitles re-burned with `--redo burnSubtitles` for $0 after a font fix | 11.1 s | $1.08 |
| `examples/07-train-blocking.mp4` | 3-shot storyboard with blocking (F18): she runs left→right to the door, conductor speaks, she answers; the script checks caught 3 staging errors before any video was paid. Rescued with `--redo` for $0.004 after two gate fixes ("for fifty dollars", voice-over speed-up) | 20.6 s | $2.92 |
| `examples/06-castle-dialogue-final.mp4` | 3-shot storyboard: wide castle → king speaks → daughter answers; cuts inside shots, subtitles. Rescued with `--redo` for $0 after the gate caught an ASR hallucination | 18.2 s | $1.76 |
| `examples/05-castle-storyboard-wide.mp4` | storyboard in Ukrainian ("1 кадр … 2 кадр …"), wide shots, burned-in subtitles: "Hello? Is anyone still here?" | 9 s | $1.37 |
| `examples/04-lighthouse-keeper-22s.mp4` | two long lines, 48 words; same face in both shots (portraits-only references) | 22 s | $2.08 |
| `examples/02-dialogue-mother-son.mp4` | two speakers: "Open it after I leave." / "Mom, are you sick?" | 10.2 s | $1.01 |
| `examples/03-watchmaker-numbers.mp4` | "It stopped in 1987, at 3:15 a.m., and so did I." | 11.5 s | $1.18 |
| `examples/01-barista.mp4` | first live run, one speaker | 10.5 s | $1.07 |

## How it works

```
idea ─► writeScript ─► checkContinuity ─► cast ─► drawKeyframes ─► shot ×N ─► assemble ─► burnSubtitles ─► finalGate
        LLM + Zod,     LLM critic reads   portraits keyframes      Seedance 2.0   ffmpeg:     cues timed by      probe + ASR of
        blocking per   the whole script   (image)   + VLM judge    + ASR gate     1080×1920,  ASR words, text    the final file,
        shot, checked  like an editor                              + VLM judge    loudnorm    = the verified     WER = 0
        by code                                                    on the video               line
```

- **Graph:** LangGraph.js `StateGraph`. Shots fan out with `Send`. The state is checkpointed to SQLite after every
  step, so `--resume` re-runs only what didn't finish (paid clips are never regenerated).
- **Contracts:** each stage's output is a Zod schema in `src/schemas.ts`. LLM output that fails the schema is fed
  back to the model with the exact errors (max 3 tries).
- **Verbatim gate** (`src/verbatim.ts`): text is normalised (case, punctuation, numbers → words, `& $ %` spelled
  out) and compared token by token with Levenshtein. WER must be exactly 0. Quoted lines in the idea are extracted
  by code, never by the LLM. Numbers, times, money and abbreviations accept any honest reading ("1987" =
  "nineteen eighty-seven", "3:15 a.m." = "3.15am", but "1987" ≠ "1988"). A line that can't be spoken (not English,
  emoji only, over 15 s) is rejected **before** any paid call.
- **Native speech first, fallback second:** Seedance 2.0 speaks the line from the prompt. If ASR hears a different
  line, it retries (`maxNative`). If that also fails, the line is synthesized by TTS, checked by ASR before use, and
  put on the clip by a lip-sync model. In that branch the audio is the source of truth.
- **Quality judge:** a VLM (Gemini) scores keyframes and clips against a rubric; for clips it watches the video
  itself (frames only as a fallback) and checks the blocking: direction, pace, whose lips move. A keyframe below 7 is redrawn with the
  judge's issues added to the prompt (max 2 extra). A clip below 5 is regenerated once, only if the budget allows.
  Otherwise the best take is kept and flagged `needsReview`.
- **Storyboards and shot sizes:** an idea may be written as shots ("Shot 1: … Shot 2: …" or "1 кадр … 2 кадр …"),
  up to 4 shots, wide or close, with cuts inside a shot. On a wide shot the line can be a voice-over.
- **Blocking and continuity:** the script states, for every shot and cut, where each person stands (foreground/
  background, left/right, facing), who moves where toward which *visible* target, at what pace, and who speaks. Code
  rejects a script that breaks the 180° rule, plays a line over another character's face, asks for slow motion the
  idea didn't ask for, or names a target with no place in frame. An LLM critic then reads the whole script for
  contradictions ("runs away from the castle, next shot is inside it"). The same staging sentences go into the video
  prompt and the judge's rubric.
- **One or two characters:** each has a portrait and a written voice; each spoken shot has one `speaker`, so a
  dialogue becomes shot / reverse shot. Seedance prompts follow its official guide (`Name says in English: {line}`,
  `@Image 1 (Name)` references, audio policy first, constraints last; see `docs/research/seedance-playbook.md`).
- **Real-face filter:** Seedance refuses photoreal images that "may contain a real person", including our own
  generated keyframes. Refusals cost $0, so a shot steps down: keyframe as first frame → portrait + keyframe as
  references → portraits only → text only. Portraits-only was checked live and keeps the face.
- **ASR hallucinations:** Whisper "hears" *Thank you for watching* in silence. A shot meant to be silent is listened
  to and muted if speech is heard, and the final gate ignores words heard inside digital silence.
- **Same-sound readings:** spellings of one spoken word pass (Kyiv/Kiev, ticket's/tickets, grey/gray), and inside a
  number written in digits a number word may come back as its homophone ("$4.50" heard as "for fifty dollars").
  Different words still fail ("we'll" ≠ "well", "four apples" ≠ "for apples"). Real Whisper transcripts from live
  runs are kept as a regression set in `pnpm verify`.
- **Nothing silent:** every retry, fallback, judge score and cost goes into `manifest.attempts[]`.
- **Idempotent:** every generated file is content-addressed (`once()`), so a re-run with the same inputs costs $0.

## Measuring it

```sh
npx tsx evals/run.ts --mock --limit 3                  # 10 fixed ideas (numbers, names, curly quotes, a 15-word line…)
npx tsx evals/run.ts --mock --set hard                 # 19 hard ideas: dialogue, years/times/money, diacritics, emoji, Ukrainian…
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
- Result so far: 20 features, ~40 implementer runs, ~18 returns by the gate or the reviewer (nearly all real bugs),
  2 features BLOCKED and unblocked by a human note in the spec. F10/F11 came from a $0 stress test of 19 hard ideas
  (`docs/research/hard-ideas-report.md`); F12–F20 came from watching live videos (wrong framing, faces swapped, a run away
  from the goal, a failure a reviewer couldn't act on).

## Repo map

| Path | What |
| --- | --- |
| `src/cli.ts`, `src/graph.ts` | the command and the LangGraph pipeline |
| `src/nodes/` | stages: script, visuals (keyframes, talking shot), voice, gate, quality, assemble, final gate |
| `src/providers/` | one interface per capability; live adapters + mocks; `index.ts` is the only import door |
| `src/schemas.ts`, `src/verbatim.ts` | contracts and the verbatim gate |
| `src/prompts/` | versioned prompts (script, continuity, staging, visuals, judge); the version is part of the cache key |
| `src/web/`, `deploy/` | the web demo and its Docker deploy |
| `src/obs/` | trace spans, metrics, Langfuse export |
| `specs/` | the feature specs the agents built from, each with its Decisions section |
| `docs/research/` | model and tooling research with sources (VERIFIED / UNCERTAIN) |
| `docs/ai-log.md` | where AI got it wrong and how it was caught |
| `evals/`, `scripts/bench.ts` | eval set and model benchmark |

## Known limits

- English lines only. No major video model officially supports Ukrainian speech yet, and the ASR gate would need a
  per-language normaliser.
- The pipeline was developed against mocks; only a handful of live runs were paid for (`examples/`, each with its
  manifest). When every image rung is refused, a shot falls back to text-to-video and the face can drift between
  shots.
- Seedance follows the staging only most of the time: a run can still look like running on a treadmill. The judge
  flags it; there is no guarantee.
- The judge is not calibrated against human ratings, so its score is a filter, not a measure.
- Lip-sync fallback via fal Kling caps a lipsynced clip at `LIPSYNC_MAX_SECONDS` (10 s).
