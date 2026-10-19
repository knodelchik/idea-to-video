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

## Decisions
- **Docs checked (all fetched 2026-10-19):**
  - TS SDK setup: https://langfuse.com/docs/observability/sdk/typescript/setup ("Shutdown flushes events and is
    required for short-lived applications"; `LANGFUSE_BASE_URL`; `LangfuseSpanProcessor`).
  - Observation types: https://langfuse.com/docs/observability/features/observation-types.
  - Generation attributes (usage/cost): https://langfuse.com/docs/observability/features/token-and-cost-tracking
    ("Only `generation` and `embedding` observations track cost"; ingested cost beats inferred cost).
  - Scores: https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk (`langfuse.score.create`, BOOLEAN
    needs an explicit `dataType` and 0/1).
  - Multi-modality: https://langfuse.com/docs/observability/features/multi-modality.
  - Environments: https://langfuse.com/docs/observability/features/environments (`^(?!langfuse)[a-z0-9-_]+$`, ≤ 40).
  - The installed 6.0.1 `.d.ts` / `.mjs` files for exact signatures (`StartObservationOpts`, `PropagateAttributesParams`,
    `LangfuseOtelSpanAttributes`, `LangfuseSpanProcessor` options, `ScoreManager`).
- **Replay at run end, not live spans.** `trace.jsonl` stays the source. `planTrace` / `planScores` in
  `src/obs/langfuse.ts` are pure, and `src/obs/langfuse-sdk.ts` replays the plan with each span's recorded start and end.
  Live spans would mean a second instrumentation path through every node and provider. Rejected.
- **SDK wiring:** `LangfuseSpanProcessor` on a `NodeTracerProvider`, made the Langfuse provider through
  `setLangfuseTracerProvider` (isolated, not `register()`ed globally, so LangGraph/LangSmith never pick it up). Then
  `startObservation(name, attrs, { asType, startTime, parentSpanContext })`, then `provider.forceFlush()` +
  `shutdown()` and `client.shutdown()`. All of it happens inside `runPipeline`, so it is done before `main()` returns.
  Rejected `NodeSDK` (the docs' example): it pulls in `@opentelemetry/sdk-node` and registers globally.
  - SDK quirk: `parent.startObservation()` (the child method) forwards only `asType` and **drops `startTime`**, so the
    replay calls the top-level `startObservation` with `parentSpanContext` (a documented option).
  - Trace attributes (`langfuse.trace.name`, `session.id`, `langfuse.trace.tags`) are set on each non-event span
    directly. `propagateAttributes` needs an active OTel context, which needs a globally registered context manager,
    and a replay creates spans with explicit parents, not inside active contexts. Events end in their constructor, so
    they carry only observation attributes.
  - Trace input/output: set on the root observation **and** as `langfuse.trace.input` / `output` (the attribute is
    still in the v6 `LangfuseOtelSpanAttributes` enum, and v6 has no `updateTrace`).
  - Trace id: random per export (the SDK default), so a `--redo` is a new trace in the **same session**
    (`sessionId = runId`). A seeded id would put two `make-video` roots in one trace.
- **Lazy load (acceptance 3):** `langfuse.ts` imports no SDK. `exportToLangfuse` does `await import("./langfuse-sdk.ts")`
  only when `langfuseFromEnv` found both keys (read from the env the CLI was given, i.e. after tsx loaded the env
  file). `sdkLoads` counts loads for the test.
- **Types:** root `agent`. Nodes `span`, except `final-gate` → `guardrail` (the verbatim gate runs inside it; there is
  no separate verbatim node to type). LLM, image, video (incl. talking avatar), TTS, lip-sync → `generation`. ASR →
  `generation`, not `tool`: it has a model id and billed seconds, and only generations carry cost. Judges →
  `evaluator`. Evaluators have no usage/cost fields in Langfuse, so their model, cost and usage go in metadata. A
  `once` hit → `event` with `metadata.cached: true` and no usage/cost.
- **Names:** fixed list `OBSERVATION_NAMES`. The LLM call is `write-script` (the pipeline's only text-LLM call; a
  generation inside the `write-script` span). A node added later without a mapping keeps its kebab-cased name, so it is
  not mislabelled, and the test pins every name of a mock run to the list.
- **Model ids:** `model?` added to the image / animate / ASR / lip-sync / talking results (and the Seedance transport
  result). Live adapters fill in what they call: the fal endpoint, the BytePlus/OpenRouter model, the Groq model.
  Mocks report none, so the generation falls back to the provider name (`mock-*`). Setting `model` on `MockLlm` was
  rejected: it changes the attempt's provider label (`mock-llm:mock-llm`) that F02 tests pin.
- **Usage units:** tokens (`input`, `output`, `thinking`) from `CallMeta.usage`. Video `video_seconds`, image `images: 1`,
  TTS `characters`, ASR `audio_seconds` (new optional `AsrResult.seconds`: Groq's billed seconds, or the mock's last
  word end), lip-sync `clips: 1`. `costDetails.total` = our measured cost, which overrides Langfuse's inferred price.
  `MockLlm` now returns a rough `meta.usage` (~4 chars/token), so mock traces carry usage like live ones.
- **Media:** file metadata `{ type: "file", path, sha256, contentType }`, no `LangfuseMedia` upload. Clips are local
  and can be tens of MB, the multi-modality docs say a self-hosted bucket needs a publicly resolvable hostname for SDK
  uploads, and the path + hash already identify the artifact in `runs/<id>/`. Never base64.
- **Errors:** a failed call → `ERROR` + `statusMessage` = our error. A video refusal matching the real-face filter →
  `WARNING`, `real-face refusal at rung <mode>: …`. A failed run → the root is `ERROR`.
- **Environment / tags:** the processor's `environment` option (`mock` → `development`, `live` → `production`), also
  sent on each score. Tags: `mode:<mode>`, `storyboard` (> 1 shot), `dialogue` (2 characters), `wide` (any wide
  camera, cuts included), `subtitles` (burned).
- **Scores** go through `LangfuseClient.score.create` (`@langfuse/client` 6.0.1) on the exported trace id:
  `verbatim_wer` (comment = heard text), `verbatim_pass`, `judge_keyframe_<shot>` / `judge_clip_<shot>` (comment = the
  issues of the fresh verdict with the kept score), `needs_review`, `cost_usd`.
- **Export failures become a manifest note.** OTel reports a failed OTLP export (500, network) through its global
  error handler → `diag.error`; it never rejects `forceFlush`. While flushing, a `diag` logger collects errors, and
  they become `langfuse export failed (non-fatal): …`, redacted of both keys. The F16 "500 → note" guarantee is kept,
  now tested with an exporter that fails every export.
- **F16 tests changed, not weakened:** the tests that pinned the raw OTLP POST body (URL, Basic header, JSON shape) are
  replaced by the same checks on the SDK's exported spans. "Off without keys" is now "SDK never loaded, `fetch` never
  called, exporter empty". "500 → note" is kept.
- **Tests:** `InMemorySpanExporter` (from `@opentelemetry/sdk-trace-node`) behind a tiny subclass that does not clear
  on `shutdown()`, because the export always shuts down and the stock class empties itself. A fake score client with a
  plain counter: a `vi.fn` called in `beforeAll` read 0 calls inside the test (observed; mock state does not survive
  into the tests here). Mutation checks: judges typed `span`
  → 2 tests fail; `forceFlush` removed → the flush test fails.
- **New dependencies (two, both pinned exactly):**
  - `@opentelemetry/api` **1.9.1**. It is already the SDK's resolved peer, and `diag` comes from it (span export-error
    capture).
  - `@langfuse/core` **6.0.1**. `src/obs/langfuse-sdk.ts` imports `getGlobalLogger` from it to catch score-upload
    errors: `ScoreManager` logs them and never throws. `@langfuse/client` uses this function internally but does not
    re-export it, and pnpm's strict `node_modules` blocks imports of transitive deps, so it has to be a direct dep. It
    adds nothing new to the install, since it was already in the lockfile as a dependency of `@langfuse/client`
    (`^6.0.1`). Pinning `6.0.1` resolves to the same `.pnpm/@langfuse+core@6.0.1_@opentelemetry+api@1.9.1` instance
    the client uses. That matters because the logger is a module-level singleton, and wrapping a second copy would
    catch nothing. Rejected: matching on the client's console output, which is brittle and silent at
    `LANGFUSE_LOG_LEVEL=NONE`. Also rejected: deep-importing the client's bundled dist path.
  - `@langfuse/client`, `@langfuse/otel`, `@langfuse/tracing` 6.0.1 and `@opentelemetry/sdk-trace-node` 2.12.0 were
    already in `package.json` (pinned by the spec commit).
- **Supply-chain guard, a narrow exception:** `pnpm-workspace.yaml` adds `minimumReleaseAgeExclude` for exactly
  `@langfuse/client@6.0.1`, `@langfuse/core@6.0.1`, `@langfuse/otel@6.0.1`, `@langfuse/tracing@6.0.1`. Why: the spec
  requires 6.0.1 pinned exactly. The npm registry shows all four published on 2026-10-19 between 07:12 and 07:13 UTC
  (`pnpm view @langfuse/core time`). That is less than a day before this work, so pnpm 11's release-age check
  (`minimumReleaseAge`, https://pnpm.io/settings#minimumreleaseage) refuses to resolve them. Scope: the entries are
  `name@version`, not bare names. The guard stays on for every other package and for any later `@langfuse/*`
  release. No other package is excluded. Rejected: (a) disabling `minimumReleaseAge` globally, which loosens the guard
  for every dependency; (b) downgrading to 6.0.0, which contradicts the spec's pin and was itself only 5 days old;
  (c) waiting a day, which blocks the feature on a clock. **Follow-up:** after 2026-10-20 07:13 UTC the four entries
  are no longer needed and should be deleted. The yaml carries a comment that says so.
  The risk is that a freshly published release ships unvetted. It is accepted because the publisher is Langfuse's
  official scope, the versions are exact (the lockfile pins integrity hashes), and the SDK only loads when Langfuse
  keys are set.
- **Acceptance 5 (live, human):** not run by the gate (no network, no env file). To do: a mock run with the Langfuse
  keys set, then `GET /api/public/v2/observations?traceId=<id>`, and re-check the audit table here.
