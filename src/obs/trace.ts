/**
 * Run trace (F16): one JSONL span per provider call and per graph node, in `runs/<id>/trace.jsonl`. The manifest says
 * what each step decided; the trace says what was sent and what came back (prompt, rubric, finish reason, raw text),
 * so a bad reply can be explained without replaying a paid call.
 *
 * Context travels in AsyncLocalStorage: the graph sets `{ runId, node, shotId?, parentId }` around each node run, and
 * every span emitted inside (by `withTrace`, or by a `once` cache hit) is linked to it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SPAN_KINDS = ["node", "llm", "image", "video", "tts", "asr", "judge", "lipsync"] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];
export type CallKind = Exclude<SpanKind, "node">;

/** A file referenced by a call: its path and content hash, never its bytes (no base64 in a trace). */
export interface FileRef {
  path: string;
  sha256: string | null;
}

export interface Span {
  id: string;
  parentId?: string;
  runId: string;
  node: string;
  shotId?: string;
  kind: SpanKind;
  provider: string;
  model?: string;
  startedAt: string;
  ms: number;
  ok: boolean;
  error?: string;
  costUsd: number;
  /** A `once` hit: the artifact existed, nothing was called, nothing was paid. */
  cached?: boolean;
  usage?: { input: number; output: number; thinking?: number };
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface TraceSink {
  write(span: Span): void;
}

/**
 * Appends one line per span, synchronously: a crash keeps every line written before it. Known secret values are
 * replaced before the line is written, a second line of defence behind "spans never carry headers or keys".
 */
export class JsonlSink implements TraceSink {
  /** Spans this process wrote (the Langfuse export sends these, not the whole file of earlier runs). */
  readonly spans: Span[] = [];
  private readonly secrets: string[];
  constructor(
    readonly path: string,
    secrets: string[] = [],
  ) {
    // Short values would redact common words; real keys are long.
    this.secrets = secrets.filter((s) => s.length >= 8);
    mkdirSync(dirname(path), { recursive: true });
  }
  write(span: Span): void {
    let line = JSON.stringify(span);
    for (const s of this.secrets) line = line.split(s).join("[redacted]");
    this.spans.push(JSON.parse(line) as Span);
    appendFileSync(this.path, `${line}\n`);
  }
}

/** In-memory sink for tests and tools. */
export class MemorySink implements TraceSink {
  readonly spans: Span[] = [];
  write(span: Span): void {
    this.spans.push(span);
  }
}

export interface TraceContext {
  runId: string;
  node: string;
  shotId?: string;
  /** The node span the calls inside belong to. */
  parentId?: string;
  /** Where cache-hit spans go (provider spans go to `withTrace`'s sink). */
  sink?: TraceSink;
}

const als = new AsyncLocalStorage<TraceContext>();

export const currentTrace = (): TraceContext | undefined => als.getStore();
export const withTraceContext = <T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> => als.run(ctx, fn);

export const newSpanId = (): string => randomBytes(8).toString("hex");

/** Every call outside a node context (a test calling a provider directly) is still traced, just unlinked. */
export function linkFields(): Pick<Span, "runId" | "node" | "shotId" | "parentId"> {
  const c = currentTrace();
  return {
    runId: c?.runId ?? "(none)",
    node: c?.node ?? "(none)",
    ...(c?.shotId ? { shotId: c.shotId } : {}),
    ...(c?.parentId ? { parentId: c.parentId } : {}),
  };
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    return h.digest("hex");
  } catch {
    return null; // a missing input is the provider's error to report, not the trace's
  }
}

export const fileRef = async (path: string): Promise<FileRef> => ({ path, sha256: await sha256File(path) });
export const fileRefs = (paths: string[] | undefined): Promise<FileRef[]> => Promise.all((paths ?? []).map(fileRef));

/** `once` writes to `<name>.tmp-<pid>-<hex><ext>` then renames; the trace shows the name the artifact ends up with. */
export function finalPath(p: string): string {
  return p.replace(/\.tmp-\d+-[0-9a-f]{8}(?=\.[^./]+$|$)/, "");
}

export const TEXT_LIMIT = 4096;

/** Reply text up to 4 kB; longer text is cut and its full length kept. */
export function clipText(text: string): { text: string; textLength?: number; truncated?: true } {
  return text.length <= TEXT_LIMIT ? { text } : { text: text.slice(0, TEXT_LIMIT), textLength: text.length, truncated: true };
}

/** What `once` tells the trace about a provider call it may skip. */
export interface CacheTrace {
  kind: CallKind;
  provider: string;
  request?: Record<string, unknown>;
}

/** A `once` hit inside a traced node: one span with `cached: true` and cost 0, so a redo shows what it reused. */
export function recordCached(t: CacheTrace, out: string): void {
  const sink = currentTrace()?.sink;
  if (!sink) return;
  sink.write({
    id: newSpanId(),
    ...linkFields(),
    kind: t.kind,
    provider: t.provider,
    startedAt: new Date().toISOString(),
    ms: 0,
    ok: true,
    costUsd: 0,
    cached: true,
    request: t.request ?? {},
    response: { path: out },
  });
}
