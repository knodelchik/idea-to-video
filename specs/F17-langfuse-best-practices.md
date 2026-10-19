# F17 — Langfuse tracing by the book: official SDK, readable traces, scores

## Goal
F16 exports each run to Langfuse over raw OTLP. The first real trace reached the author's self-hosted Langfuse on
2026-10-19 (run 20261019-115008-4d8b76: 22 observations, correct nesting). Audited against
https://langfuse.com/docs/observability/best-practices (fetched 2026-10-19) via the Langfuse skill
(`~/.claude/skills/langfuse`, references/instrumentation.md), it has these gaps:

| Best practice | Today | Needed |
| --- | --- | --- |
| Use the current SDK (skill rule 4) | raw OTLP JSON via fetch | `@langfuse/tracing` + `@langfuse/otel` **6.0.1**, `@opentelemetry/sdk-trace-node` **2.12.0**, pinned exactly |
| Root input/output readable at a glance | root input/output `null` | root input = the idea; output = `{ ok, finalPath, seconds, wer, costUsd, error? }` |
| Stable, verb-first names; no dynamic values or model names in names | `run 2026…`, `shot s1`, `asr mock-asr` | `make-video`, `write-script`, `cast-portraits`, `draw-keyframes`, `render-shot`, `generate-image`, `generate-video`, `synthesize-voice`, `transcribe-audio`, `judge-keyframe`, `judge-clip`, `lipsync`, `assemble`, `burn-subtitles`, `final-gate`; runId, shotId, provider and mode go into metadata |
| The most specific observation type | everything `generation` or `span` | LLM, image, video and TTS calls → `generation`; judges → `evaluator`; ASR → `tool` (or `generation` if it has a model and usage, decided by the docs); the graph root → `agent`; graph nodes → `span`; the verbatim gate and final gate → `guardrail`; a cached (`once` hit) step → `event` with `cached: true` |
| Model name and usage on every generation | model = provider name; usage `{}` | real model id (`gemini-3.5-flash`, `bytedance/seedance-2.0-fast`, `bytedance-seed/seedream-5-0-flash`, `whisper-large-v3-turbo`…), `usageDetails` (input/output/thinking tokens; video seconds as a custom usage unit), `costDetails.total` = our measured cost (we know it from the provider, so override automatic pricing) |
| LLM input as role-labeled messages | `{system, user}` object | `[{role:"system",content}, {role:"user",content}]` for the script writer and the judges; image and video inputs as Langfuse media references or file metadata (decided by the multi-modality docs; never base64 inline in metadata) |
| Errors visible | level `DEFAULT` everywhere | failed calls → `level: "ERROR"` with `statusMessage` = our reason; refusals of the real-face ladder → `WARNING` with the rung |
| Environment and tags known upfront | `default`, no tags | `environment`: `mock` → `development`, `live` → `production`; tags such as `mode:live`, `storyboard`, `dialogue`, `wide`, `subtitles` from the script |
| Session | `sessionId = runId` | keep `sessionId = runId` so a `--redo` of the same run lands in the same session as the original |
| Quality as scores (labels known after the fact) | none | at run end, scores on the trace: `verbatim_wer` (numeric), `verbatim_pass` (boolean), `judge_keyframe_<shot>`, `judge_clip_<shot>` (numeric 0–10, comment = issues), `needs_review` (boolean), `cost_usd` (numeric) |

## Scope
- `src/obs/langfuse.ts` is rewritten on the SDK. The span model in `trace.jsonl` (F16) stays the source; `withTrace` and the
  JSONL sink stay as they are, so offline traces and the web demo keep working without Langfuse.
- Map spans to Langfuse observations at run end, or live as they happen if the SDK makes that simple. Either way, call
  `forceFlush()` / `shutdown()` before the CLI exits (the skill's top common mistake).
- Read `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (or `LANGFUSE_HOST`) only after the env is
  loaded. With the keys missing, nothing loads and nothing is sent.
- Scores go through the SDK client (`@langfuse/client` 6.0.1) or the public scores API, whichever the docs say is current.
- Secrets never reach Langfuse: no API keys, no request headers. Paths stay as they are (local, not secret).
- **Docs first:** before writing code, fetch the current pages and record them with dates in Decisions:
  - the TS SDK setup;
  - observation types (`asType`);
  - the generation attributes;
  - scores;
  - multi-modality;
  - environments and tags.

## Acceptance
1. Unit tests with an in-memory span exporter (the OTel `InMemorySpanExporter`):
   - a mock run produces a root `agent` named `make-video` whose input is the idea and whose output has `ok`;
   - names come only from the stable list above, with no digits or provider names in them;
   - judges are `evaluator`;
   - failed spans are `ERROR` with `statusMessage`;
   - generations carry the model, usage and cost;
   - `environment` is `development` for mock.
2. Scores: a mock run creates `verbatim_wer`, `verbatim_pass`, `judge_clip_s1` and `cost_usd` (fake client).
3. Without keys, the SDK is never initialised and no network call is made.
4. The CLI flushes before exit. A test spies on `forceFlush`/`shutdown`.
5. A mock run against the real self-hosted Langfuse (`LANGFUSE_BASE_URL` from `.env`) is fetched back through
   `GET /api/public/v2/observations?traceId=…` (the skill's CLI rule: observations, not the deprecated traces endpoints).
   The audit table above is re-checked and its result written into Decisions. This acceptance step is run by the human
   orchestrator, not by the gate, because the gate has no network.
6. `pnpm verify` green; F01–F16 tests still pass.
