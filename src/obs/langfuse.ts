/**
 * Optional Langfuse export (F16). Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set. At run end the
 * spans go to Langfuse in ONE POST: a trace per run (a root span carrying the trace name), the graph nodes as spans,
 * and every provider call as a generation with model, usage and cost.
 *
 * Transport: OTLP/HTTP with a JSON body to `<host>/api/public/otel/v1/traces`, Basic auth (public:secret). Not the
 * legacy `/api/public/ingestion` batch endpoint: Langfuse's public-API page (checked 2026-10-19) says that one "is
 * deprecated and is sunset on Langfuse Cloud on November 16, 2026" and that OpenTelemetry "is the supported path".
 * Attribute names follow langfuse.com/integrations/native/opentelemetry (checked 2026-10-19). Plain fetch, no SDK.
 */
import { createHash } from "node:crypto";
import type { Env, FetchLike } from "../providers/index.ts";
import type { Span } from "./trace.ts";

/** Langfuse Cloud EU (the public-API page lists https://cloud.langfuse.com/api/public as EU). */
export const LANGFUSE_EU_HOST = "https://cloud.langfuse.com";
export const OTLP_PATH = "/api/public/otel/v1/traces";
const TIMEOUT_MS = 15_000;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

/** Both keys → config; either missing → undefined (export off, nothing is ever sent). */
export function langfuseFromEnv(env: Env): LangfuseConfig | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return undefined;
  // LANGFUSE_BASE_URL is the current SDK's name (the self-hosted project page shows it); LANGFUSE_HOST is the older one.
  const host = (env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || LANGFUSE_EU_HOST).replace(/\/+$/, "");
  return { publicKey, secretKey, host };
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface Attr {
  key: string;
  value: AnyValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
}
export interface OtlpBody {
  resourceSpans: { resource: { attributes: Attr[] }; scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[] }[];
}

const hex = (s: string, n: number): string => createHash("sha256").update(s).digest("hex").slice(0, n);
const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const json = (key: string, v: unknown): Attr => str(key, JSON.stringify(v));
const nanos = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/** OTel ids: 32 hex trace id from the run id (stable across resumes), 16 hex span ids (ours already are). */
export const otelTraceId = (runId: string): string => hex(`trace:${runId}`, 32);
const otelSpanId = (id: string): string => (/^[0-9a-f]{16}$/.test(id) ? id : hex(`span:${id}`, 16));

/** Spans of one run → one OTLP body: root (trace) span, node spans, provider generations. Pure. */
export function toOtlp(spans: Span[], run: { runId: string; idea?: string }): OtlpBody {
  const traceId = otelTraceId(run.runId);
  const rootId = hex(`root:${run.runId}`, 16);
  const start = (s: Span) => Date.parse(s.startedAt);
  const t0 = spans.length ? Math.min(...spans.map(start)) : Date.now();
  const t1 = spans.length ? Math.max(...spans.map((s) => start(s) + s.ms)) : t0;
  // Trace-level attributes go on every span (Langfuse's advice for reliable filtering).
  const traceAttrs = [str("langfuse.trace.name", "idea-to-video"), str("langfuse.session.id", run.runId), str("langfuse.trace.metadata.runId", run.runId)];
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: `run ${run.runId}`,
    kind: 1,
    startTimeUnixNano: nanos(t0),
    endTimeUnixNano: nanos(t1),
    attributes: [...traceAttrs, str("langfuse.observation.type", "span"), ...(run.idea ? [json("langfuse.trace.input", run.idea)] : [])],
    status: { code: spans.every((s) => s.ok || s.kind !== "node") ? 1 : 2 },
  };
  const ids = new Set(spans.map((s) => s.id));
  const out = spans.map((s): OtlpSpan => {
    const generation = s.kind !== "node";
    const attrs: Attr[] = [
      ...traceAttrs,
      str("langfuse.observation.type", generation ? "generation" : "span"),
      json("langfuse.observation.input", s.request),
      json("langfuse.observation.output", s.response),
      str("langfuse.observation.metadata.kind", s.kind),
      str("langfuse.observation.metadata.provider", s.provider),
      ...(s.shotId ? [str("langfuse.observation.metadata.shotId", s.shotId)] : []),
      ...(s.cached ? [str("langfuse.observation.metadata.cached", "true")] : []),
      ...(s.ok ? [] : [str("langfuse.observation.level", "ERROR"), str("langfuse.observation.status_message", s.error ?? "failed")]),
    ];
    if (generation) {
      attrs.push(str("langfuse.observation.model.name", s.model ?? s.provider));
      attrs.push(json("langfuse.observation.cost_details", { total: s.costUsd }));
      if (s.usage) {
        attrs.push(json("langfuse.observation.usage_details", { input: s.usage.input, output: s.usage.output, ...(s.usage.thinking ? { thinking: s.usage.thinking } : {}) }));
      }
    }
    return {
      traceId,
      spanId: otelSpanId(s.id),
      // A parent missing from this batch (a span outside a node) hangs off the root instead of dangling.
      parentSpanId: s.parentId && ids.has(s.parentId) ? otelSpanId(s.parentId) : rootId,
      name: generation ? `${s.kind} ${s.provider}` : s.shotId ? `${s.node} ${s.shotId}` : s.node,
      kind: generation ? 3 : 1, // CLIENT for outbound calls, INTERNAL for graph nodes
      startTimeUnixNano: nanos(start(s)),
      endTimeUnixNano: nanos(start(s) + s.ms),
      attributes: attrs,
      status: s.ok ? { code: 1 } : { code: 2, message: s.error ?? "failed" },
    };
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "idea-to-video")] },
        scopeSpans: [{ scope: { name: "idea-to-video" }, spans: [root, ...out] }],
      },
    ],
  };
}

export type ExportResult = { ok: true } | { ok: false; error: string };

/** One POST of the whole run. Never throws: the caller records a failure as a note. */
export async function exportToLangfuse(
  spans: Span[],
  opts: { runId: string; idea?: string; config: LangfuseConfig; fetch?: FetchLike },
): Promise<ExportResult> {
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const { publicKey, secretKey, host } = opts.config;
  try {
    const res = await f(`${host}${OTLP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      },
      body: JSON.stringify(toOtlp(spans, { runId: opts.runId, ...(opts.idea ? { idea: opts.idea } : {}) })),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: redact(`HTTP ${res.status}${body ? `: ${body}` : ""}`) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redact(e instanceof Error ? e.message : String(e)) };
  }
  // The error goes into the manifest; an echoed key must not.
  function redact(s: string): string {
    return s.split(secretKey).join("[redacted]").split(publicKey).join("[redacted]");
  }
}
