# idea-to-video — agent map

One command turns a 1–3 sentence idea into an 8–30 s vertical (9:16) video in which the spoken line is
**word-for-word** the line from the script (or from the idea, when the idea quotes one).

Read this file, then the spec you were given. Everything else is linked from here; don't read the whole repo.

## Where things are

| Path | What |
| --- | --- |
| `src/schemas.ts` | Zod contracts between stages. The single source of truth for data shapes. |
| `src/graph.ts` | LangGraph.js state graph: stages, retries, routing. |
| `src/nodes/` | One file per stage. A node reads state, calls providers, returns a state patch. |
| `src/providers/` | Adapters behind interfaces (`llm`, `tts`, `asr`, `image`, `video`, `lipsync`). Each has a `mock` twin. |
| `src/media/` | ffmpeg / ffprobe wrappers. Pure arg builders are unit-tested. |
| `src/obs/` | Run trace (`runs/<id>/trace.jsonl`, `withTrace`), metrics across runs (`pnpm metrics`), optional Langfuse export. |
| `src/web/` | Hosted demo (F15): `pnpm web`, access code, gallery + inspector, one run at a time over SSE. Deploy in `deploy/`. |
| `src/verbatim.ts` | Text normalisation + word error rate: the verbatim gate. |
| `src/cli.ts` | `pnpm make "idea"` entry point. |
| `specs/` | Feature specs. `specs/features.json` is the backlog with status; one spec per feature. |
| `docs/research/` | Model / tooling research with sources. Read only the part your spec points to. |
| `docs/ai-log.md` | Where AI (you) got something wrong and how it was caught. Append, never rewrite. |
| `PROGRESS.md` | One entry per finished feature. Append-only. |

## Commands

- `pnpm verify` — typecheck + unit tests + architecture checks + mock end-to-end run. **The definition of done.**
- `pnpm make "idea" --mock` — full pipeline with mock providers, zero cost.
- `pnpm test -- <file>` — one test file.

## Rules (hard)

1. **Never spend money.** Do not run anything with `--live`, do not call paid APIs, do not read `.env`.
   Live runs are started by a human only. Hooks enforce this.
2. **Every provider has a mock.** New provider = interface + live adapter + mock + unit test on the mock path.
3. **Contracts first.** Change `src/schemas.ts` before code that produces or consumes the data.
4. **Never trust the model for things code can check.** Durations, substring/verbatim checks, file formats,
   counts — validate deterministically and feed the failure back to the model as a retry.
5. **Nodes are idempotent.** Same inputs → same artifact path (content hash). A resumed run must not regenerate
   finished work.
6. **No silent fallbacks.** Every retry/fallback is recorded in the run manifest (`attempts[]`) with the reason.
7. `src/nodes` may import `providers` only through `src/providers/index.ts`. `src/providers` never imports nodes.
8. Keep files small and boring. No new dependency without a line in the spec's "Decisions" section.
9. Done = `pnpm verify` is green **and** every acceptance item in the spec is demonstrably met. If you can't
   meet one, stop and write why in the spec under "Blocked" — don't fake it (no `.skip`, no stubbed asserts).

## Style

TypeScript ESM, strict. Imports with `.ts` extensions. Small pure functions, tested. Comments explain *why*.
