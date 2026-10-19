# F16 — Observability: a trace of every model call, and metrics across runs

## Goal
`manifest.json` records what each step decided (stage, ok/reason, score, $, ms). It does not record what was **sent**
or **received**. On 2026-10-19 the clip judge returned an empty reply. Finding why meant replaying the call by hand,
because no trace held the prompt, the model, the finish reason or the raw text. This feature adds:
1. **A trace per run** (`runs/<id>/trace.jsonl`). One span per provider call: what went in, what came out, tokens,
   cost, latency, error, all linked to the run, the graph node and the shot.
2. **Metrics across runs** (`src/obs/metrics.ts`), computed from manifests and traces. The web demo (F15) shows them,
   and `pnpm metrics` prints them.
3. **Optional Langfuse export.** Off unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set. With them, spans
   go to Langfuse as a trace with nested generations. No SDK if a plain HTTPS call to the public ingestion API is
   enough. Check the current Langfuse docs and record the source and date in Decisions.

This feature has no UI; F15 builds on it.

## Scope
### Trace (`src/obs/trace.ts`)
- **Context:** `AsyncLocalStorage` holds `{ runId, node, shotId? }`. The graph sets it when each node starts; the
  shot fan-out sets `shotId`.
- **A provider wrapper `withTrace(providers, sink)`,** in the same style as `withBudget`. It wraps every method that
  calls a model or a paid API (llm, image, video, tts, asr, judge, lipsync) and emits one span per call:
  `{ id, parentId?, runId, node, shotId?, kind: "llm"|"image"|"video"|"tts"|"asr"|"judge"|"lipsync", provider,
  model?, startedAt, ms, ok, error?, costUsd, usage?: {input, output, thinking?}, request, response }`.
  - `request`: prompt text (full), rubric (full), seconds, mode (frame/refs/portraits/text), refs and media as
    **paths plus sha256**, never base64.
  - `response`:
    - text up to 4 kB, else truncated with its length;
    - finish reason when the provider gives one (Gemini `finishReason`, `promptFeedback`), so an empty judge reply
      shows why;
    - parsed verdict or score;
    - output file path.
  - Secrets never go into a span: no headers, no keys. The test greps a span file for the fake key and finds nothing.
- **Sink:** append JSONL to `runs/<id>/trace.jsonl`, one line per span, flushed per line. A crash keeps what was
  written. A cached step (`once` hit) records a span with `cached: true` and cost 0, so a redo's trace shows the
  reuse.
- **Graph node spans:** a `node` span per node run, with ms and ok, which is the parent of its provider spans.
- Spans flow through the provider wrapper. Providers that know more (Gemini finishReason, OpenRouter usage) return it
  in a `meta` field the wrapper reads. Add `meta` to the result types where it is cheap.

### Metrics (`src/obs/metrics.ts`, pure; `pnpm metrics [runsDir]`)
From all manifests (plus traces where present), as one object:
- runs, success rate, verbatim on the first take, final WER = 0 rate;
- $ per video and per successful video;
- p50/p90 wall time per stage and per run;
- attempts per stage;
- fallback rates: real-face refusals and ladder rungs used, TTS/voice-over/lip-sync, silent-shot speech dropped,
  ASR words ignored in silence;
- judge score distribution, judge failures (no verdict), needs-review rate;
- model calls by provider and model with total tokens and $;
- top failure reasons (normalised and counted).
`evals/run.ts` keeps its numbers; where they overlap it reuses these functions.

### Langfuse export (`src/obs/langfuse.ts`)
- With both keys, spans are batched to Langfuse at run end: a trace per run, the node spans as spans, and the
  provider calls as generations with model, usage and cost.
- `LANGFUSE_HOST` defaults to the cloud EU host. Failures are logged and recorded in the manifest as a non-fatal
  note; they never fail a run.
- Tests use a fake fetch.

## Acceptance
1. A mock CLI run writes `trace.jsonl`:
   - every provider call has a span with runId, node, kind, provider, ms, ok and cost;
   - shot spans carry `shotId`;
   - node spans are the parents;
   - the judge span holds the full rubric;
   - the video span holds the prompt and the ladder mode.
2. Secrets: with fake keys set in env, no span line contains them.
3. A judge reply with empty text and a finishReason (fake Gemini client) produces a span with `response.text: ""`
   and the finish reason.
4. A `--redo shot` of a mock run appends spans with `cached: true` for reused clips.
5. `metrics()` on a fixture dir of 3 manifests gives the expected numbers: success rate, $ per video, rung counts,
   ignored-in-silence count. `pnpm metrics` prints them.
6. Langfuse: off without keys, so fetch is never called. With keys, one batched POST to the ingestion endpoint
   holds a trace, node spans and generations. A 500 from Langfuse leaves the run ok, with a note.
7. `pnpm verify` green; F01–F14 tests still pass.

## Decisions
- **Langfuse transport: OTLP/HTTP JSON to `<host>/api/public/otel/v1/traces`, not the legacy `/api/public/ingestion`
  batch.** Langfuse's public-API page (https://langfuse.com/docs/api-and-data-platform/features/public-api, checked
  2026-10-19) says: "The legacy Ingestion API is deprecated and is sunset on Langfuse Cloud on November 16, 2026"
  and that OpenTelemetry "is the supported path for trace ingestion". Shipping against an endpoint that goes away
  in four weeks would leave a dead feature. It is still one batched POST per run, Basic auth `public:secret`, plain
  `fetch`, no SDK. Attribute names come from https://langfuse.com/integrations/native/opentelemetry (checked
  2026-10-19): `langfuse.observation.type` = `span` | `generation`, `langfuse.observation.model.name`,
  `langfuse.observation.usage_details` / `cost_details` (JSON), `langfuse.observation.input` / `output`, `level` /
  `status_message`, and `langfuse.trace.name` + `langfuse.session.id` on every span. Langfuse takes HTTP/JSON and
  HTTP/protobuf but not gRPC.
  - "A trace per run": OTel has no separate trace object. The trace is the shared `traceId` (sha256 of the run id,
    so it stays the same across resumes) plus a root span `run <id>` carrying `langfuse.trace.name`. Node spans hang
    off the root, and provider calls (generations) hang off their node.
  - Host default `https://cloud.langfuse.com` (the EU region per the public-API page; US is `us.cloud.langfuse.com`).
  - Rejected: the legacy `trace-create` / `span-create` / `generation-create` batch (sunset); the Langfuse JS SDK or
    OTel SDK (a dependency for one POST).
- **Context:** `AsyncLocalStorage` is set by the graph's `node()` wrapper around each node body, so every node
  (and the `shot` fan-out, which adds `shotId`) gets it without the nodes changing. LangGraph's own ALS use doesn't
  matter: we nest our own store inside the node call.
- **Order of wrappers:** `withBudget(withTrace(p))`. A call the budget refuses never reaches a model, so it has no
  span. It is already an attempt in the manifest.
- **Cached spans:** `once(out, fn, trace?)` takes an optional `{ kind, provider, request }`. Only the five call sites
  that wrap a provider call pass it: image, video, lipsync, tts, judge verdict. ffmpeg-only `once` calls (trims,
  segments, frames) are not model calls and emit nothing. A cache hit writes a span with `cached: true`, cost 0 and
  ms 0 to the sink held in the context.
- **`meta` on results:** `CallMeta { text, finishReason, promptFeedback, usage }` on `LlmResult` and `JudgeResult`,
  and as a mutable field on `JudgeOutputError`. Gemini fills it from `candidates[0].finishReason`,
  `promptFeedback.blockReason` and `usageMetadata`. `GenAiClient` gained these optional response fields; the real
  SDK still satisfies them structurally. OpenRouter / fal usage is not wired: their results carry no token
  counts yet, and the spec only asks for meta "where it is cheap".
- **`AnimateRequest.mode`** (frame / refs / portraits / text) is new and optional. visuals sets it, and providers
  ignore it. The trace needs the ladder rung, and only the node knows it (refs and portraits both send
  `textOnly`).
- **`talking`** (audio-driven avatar, never called by the pipeline) is traced as kind `video` with
  `mode: "talking"`, which keeps the spec's kind list unchanged.
- **Secrets, two layers:** spans are built only from request and result objects, never from adapter state or
  headers. On top of that, `JsonlSink` replaces any env value named `*KEY|*SECRET|*TOKEN|*PASSWORD` (≥ 8 chars)
  with `[redacted]` before writing. A Langfuse error body is redacted of both keys before it becomes a manifest note.
- **Manifest `notes: string[]`** (optional, new in `RunManifest`): non-fatal run notes, used for a failed Langfuse
  export. They never change `ok`.
- **Metrics:** `src/obs/metrics.ts` is pure. `src/obs/metrics-cli.ts` loads `<runsDir>/*/manifest.json` and
  `trace.jsonl`, skipping and listing manifests that fail the contract, and tolerating a crash-truncated last trace
  line. Wall time per stage and per run comes from node spans when there is a trace, else from summed attempt ms.
  Fallback counts are read from the attempt reasons the nodes write, and the fixture tests pin those phrases.
  `percentile` and the first-take rule (`verbatimFirstTake`) moved here; `evals/metrics.ts` imports them, so its
  numbers are unchanged.
- **No new dependencies.**
