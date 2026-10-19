/**
 * The Langfuse SDK side of the export (F17). Imported dynamically by `langfuse.ts` only when keys are set, so a run
 * without keys never loads `@langfuse/*` or OpenTelemetry.
 *
 * Setup per the TS SDK docs (fetched 2026-10-19): a `LangfuseSpanProcessor` on a tracer provider, observations made with
 * `startObservation(name, attrs, { asType })`, then flush + shutdown before the process exits (the docs: "Shutdown
 * flushes events and is required for short-lived applications"). The provider is isolated
 * (`setLangfuseTracerProvider`), not registered globally, so nothing else in the process starts exporting spans.
 *
 * The run is replayed after the fact, with each span's real start and end times. That is why trace attributes are set
 * on each span directly instead of through `propagateAttributes`: propagation rides the OTel context, which needs a
 * global context manager, and we create spans with explicit parents rather than inside active contexts.
 */
import { LangfuseClient } from "@langfuse/client";
import { getGlobalLogger } from "@langfuse/core";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
  type LangfuseObservationAttributes,
  type StartObservationOpts,
} from "@langfuse/tracing";
import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api";
import { NodeTracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { ExportResult, LangfuseConfig, LangfuseTestHooks, PlannedObservation, PlannedScore, ScoreClient, TracePlan } from "./langfuse.ts";

type Start = (name: string, attributes: LangfuseObservationAttributes, options: StartObservationOpts) => LangfuseObservation;

/**
 * OTel reports a failed export (HTTP 500, network down) through its global error handler, which logs to `diag`; it
 * never rejects `forceFlush`. Listening on `diag` (spans) and the Langfuse logger (scores) while we flush is how a
 * failed export becomes a manifest note.
 */
function collectErrors(): { errors: string[]; stop: () => void } {
  const errors: string[] = [];
  const noop = () => undefined;
  const logger: DiagLogger = {
    error: (msg, ...args) => errors.push([msg, ...args.map(describe)].join(" ")),
    warn: noop,
    info: noop,
    debug: noop,
    verbose: noop,
  };
  diag.setLogger(logger, { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true });
  // The score client never reaches `diag`: its ScoreManager catches HTTP/network errors and partial (207) rejections,
  // logs them through the Langfuse global logger, and returns. Wrap that logger's `error` (the original still prints,
  // and it records even with LANGFUSE_LOG_LEVEL=NONE) so a dropped score becomes a note too.
  const sdkLogger = getGlobalLogger();
  const sdkError = sdkLogger.error;
  sdkLogger.error = (msg: string, ...args: unknown[]) => {
    errors.push([msg, ...args.map(describe)].join(" "));
    sdkError.call(sdkLogger, msg, ...args);
  };
  return {
    errors,
    stop: () => {
      diag.disable();
      sdkLogger.error = sdkError;
    },
  };
}

function describe(a: unknown): string {
  return a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a);
}

function traceAttributes(plan: TracePlan) {
  return {
    [LangfuseOtelSpanAttributes.TRACE_NAME]: plan.traceName,
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: plan.sessionId,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: plan.tags,
  };
}

/** Creates every observation, parents first (the trace file lists a node after its calls: a node span ends last). */
function replay(plan: TracePlan): LangfuseObservation {
  const byKey = new Map(plan.observations.map((o) => [o.key, o]));
  const made = new Map<string, LangfuseObservation>();
  const shared = traceAttributes(plan);
  const make = (o: PlannedObservation): LangfuseObservation => {
    const done = made.get(o.key);
    if (done) return done;
    const parentPlan = o.parent ? byKey.get(o.parent) : undefined;
    const parent = parentPlan ? make(parentPlan) : undefined;
    // Top-level startObservation with an explicit parent: the child method `parent.startObservation()` drops
    // `startTime` (SDK 6.0.1 forwards only asType), and a replay needs each span's recorded start.
    const obs = (startObservation as Start)(o.name, o.attributes as LangfuseObservationAttributes, {
      asType: o.type,
      startTime: o.startTime,
      ...(parent ? { parentSpanContext: parent.otelSpan.spanContext() } : {}),
    });
    // An event ended in its constructor; attributes set now would be dropped, and it needs no trace-level ones.
    if (o.type !== "event") obs.otelSpan.setAttributes(shared);
    made.set(o.key, obs);
    return obs;
  };
  for (const o of plan.observations) make(o);
  const root = made.get("root")!;
  const rootPlan = byKey.get("root")!;
  // The trace's own input/output: the idea and the outcome (best practice: readable at a glance).
  root.otelSpan.setAttributes({
    [LangfuseOtelSpanAttributes.TRACE_INPUT]: JSON.stringify(rootPlan.attributes.input),
    [LangfuseOtelSpanAttributes.TRACE_OUTPUT]: JSON.stringify(rootPlan.attributes.output),
  });
  // Children first, root last, each at its recorded end.
  for (const o of [...plan.observations].reverse()) if (o.type !== "event") made.get(o.key)!.end(o.endTime);
  return root;
}

export async function sendTrace(
  plan: TracePlan,
  scores: PlannedScore[],
  opts: { config: LangfuseConfig } & LangfuseTestHooks,
): Promise<ExportResult> {
  const { publicKey, secretKey, baseUrl } = opts.config;
  const processor = new LangfuseSpanProcessor(
    opts.exporter
      ? { exporter: opts.exporter as SpanExporter, exportMode: "immediate", mediaUploadEnabled: false, environment: plan.environment }
      : { publicKey, secretKey, baseUrl, environment: plan.environment },
  );
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const client: ScoreClient = opts.scores ?? new LangfuseClient({ publicKey, secretKey, baseUrl });
  const listen = collectErrors();
  setLangfuseTracerProvider(provider);
  let traceId = "";
  try {
    const root = replay(plan);
    traceId = root.traceId;
    for (const s of scores) {
      client.score.create({ traceId, name: s.name, value: s.value, dataType: s.dataType, environment: plan.environment, ...(s.comment ? { comment: s.comment } : {}) });
    }
  } finally {
    // Flush before the CLI exits, even after a failed replay (the skill's top mistake: a script that never flushes).
    try {
      await provider.forceFlush();
      await provider.shutdown();
      await client.shutdown();
    } finally {
      setLangfuseTracerProvider(null);
      listen.stop();
    }
  }
  const err = listen.errors.join("; ").slice(0, 300);
  return err ? { ok: false, error: err } : { ok: true, traceId };
}
