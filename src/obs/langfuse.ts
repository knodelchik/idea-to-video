/**
 * Optional Langfuse export (F16, rewritten on the official SDK in F17). Off unless LANGFUSE_PUBLIC_KEY and
 * LANGFUSE_SECRET_KEY are both set; then, at run end, the spans of `trace.jsonl` become one Langfuse trace and the
 * manifest's quality numbers become scores on it.
 *
 * This file is pure: it plans observations (names, types, attributes) and scores from spans and the manifest. The SDK
 * lives in `langfuse-sdk.ts` and is imported dynamically only when keys are set, so a run without keys never loads it.
 * Docs followed (fetched 2026-10-19): observability/best-practices, sdk/typescript/setup, features/observation-types,
 * features/token-and-cost-tracking, evaluation/evaluation-methods/scores-via-sdk, features/multi-modality,
 * features/environments.
 */
import type { Env } from "../providers/index.ts";
import { isWide, type RunManifest } from "../schemas.ts";
import type { Span } from "./trace.ts";

/** Langfuse Cloud EU, the SDK's own default. */
export const LANGFUSE_EU_HOST = "https://cloud.langfuse.com";

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Both keys → config; either missing → undefined (export off: the SDK is never loaded, nothing is sent). */
export function langfuseFromEnv(env: Env): LangfuseConfig | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return undefined;
  // LANGFUSE_BASE_URL is the SDK's name (setup docs); LANGFUSE_HOST the older one.
  const baseUrl = (env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim() || LANGFUSE_EU_HOST).replace(/\/+$/, "");
  return { publicKey, secretKey, baseUrl };
}

// --- names and types ---

/** The only observation names (best practice: stable, verb-first, no ids or model names; those go in metadata). */
export const OBSERVATION_NAMES = [
  "make-video",
  "write-script",
  "cast-portraits",
  "draw-keyframes",
  "render-shot",
  "generate-image",
  "generate-video",
  "synthesize-voice",
  "transcribe-audio",
  "judge-keyframe",
  "judge-clip",
  "check-continuity",
  "lipsync",
  "assemble",
  "burn-subtitles",
  "final-gate",
] as const;
export type ObservationName = (typeof OBSERVATION_NAMES)[number];
export type ObservationType = "agent" | "span" | "generation" | "evaluator" | "guardrail" | "event";

const NODE_NAMES: Record<string, ObservationName> = {
  writeScript: "write-script",
  cast: "cast-portraits",
  drawKeyframes: "draw-keyframes",
  shot: "render-shot",
  assemble: "assemble",
  burnSubtitles: "burn-subtitles",
  finalGate: "final-gate",
};

/** The continuity critic (F18) is an LLM call marked with its purpose. */
const isContinuityCheck = (s: Span): boolean => s.kind === "llm" && s.request.purpose === "continuity";

/** A judge span judged a keyframe when it sent one image; a clip otherwise (frames or video). */
const isKeyframeJudge = (s: Span): boolean => s.request.image !== undefined;

/** A node added later without a mapping keeps its own name, kebab-cased (not mislabelled); a test pins the list. */
const kebab = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z-]+/g, "-").toLowerCase();

export function observationName(s: Span): string {
  switch (s.kind) {
    case "node":
      return NODE_NAMES[s.node] ?? kebab(s.node);
    case "llm":
      // The script writer, or the continuity critic that reads its script (F18).
      return isContinuityCheck(s) ? "check-continuity" : "write-script";
    case "image":
      return "generate-image";
    case "video":
      return "generate-video";
    case "tts":
      return "synthesize-voice";
    case "asr":
      return "transcribe-audio";
    case "judge":
      return isKeyframeJudge(s) ? "judge-keyframe" : "judge-clip";
    case "lipsync":
      return "lipsync";
  }
}

/**
 * Most specific type (observation-types docs). Model calls are generations: only generations carry usage and cost
 * (token-and-cost docs), and ASR has a model id and a billed duration, so it is one too. Judges are evaluators, the
 * final gate (where the verbatim check runs) a guardrail. A `once` hit made no call: a point-in-time event.
 */
export function observationType(s: Span): ObservationType {
  if (s.cached) return "event";
  if (s.kind === "node") return s.node === "finalGate" ? "guardrail" : "span";
  // The continuity critic scores the script, like a judge scores a clip (F18).
  if (s.kind === "judge" || isContinuityCheck(s)) return "evaluator";
  return "generation";
}

// --- attributes ---

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  json: "application/json",
};
export const contentType = (path: string): string => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Files stay as metadata (path, sha256, content type), never bytes: the multi-modality docs upload bytes wrapped in
 * LangfuseMedia, but our clips are local, can be tens of MB, and a self-hosted bucket needs a public hostname. A path
 * plus hash identifies the artifact in `runs/<id>/` without shipping it.
 */
export function describeFiles(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(describeFiles);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.path === "string" && "sha256" in o) return { type: "file", path: o.path, sha256: o.sha256, contentType: contentType(o.path) };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, describeFiles(x)]));
  }
  return v;
}

export interface ChatMessage {
  role: "system" | "user";
  content: unknown;
}

/** LLM and judge inputs as role-labelled messages (best practice); other calls keep their request object. */
export function observationInput(s: Span): unknown {
  const r = s.request;
  if (s.kind === "llm") return [{ role: "system", content: r.system }, { role: "user", content: r.prompt }] satisfies ChatMessage[];
  if (s.kind === "judge" && typeof r.rubric === "string") {
    const { rubric, ...media } = r;
    const parts = Object.values(describeFiles(media) as Record<string, unknown>).flatMap((x) => (Array.isArray(x) ? x : [x]));
    return [{ role: "system", content: rubric }, { role: "user", content: parts }] satisfies ChatMessage[];
  }
  return describeFiles(r);
}

/** Usage in each call's own unit: tokens for text models, seconds of video or audio, images, characters spoken. */
export function usageDetails(s: Span): Record<string, number> {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (s.usage) return { input: s.usage.input, output: s.usage.output, ...(s.usage.thinking ? { thinking: s.usage.thinking } : {}) };
  switch (s.kind) {
    case "video": {
      const sec = num(s.response.seconds) ?? num(s.request.seconds);
      return sec !== undefined ? { video_seconds: sec } : { videos: 1 };
    }
    case "image":
      return { images: 1 };
    case "tts":
      return typeof s.request.text === "string" ? { characters: s.request.text.length } : {};
    case "asr": {
      const sec = num(s.response.seconds);
      return sec !== undefined ? { audio_seconds: sec } : {};
    }
    case "lipsync":
      return { clips: 1 };
    default:
      return {};
  }
}

const REAL_FACE = /real person|PrivacyInformation/i;

export type Level = "DEFAULT" | "WARNING" | "ERROR";

/** Failed call → ERROR with our reason; a real-face refusal is the ladder working as designed → WARNING with the rung. */
export function levelOf(s: Span): { level: Level; statusMessage?: string } {
  if (s.ok) return { level: "DEFAULT" };
  const why = s.error ?? "failed";
  if (s.kind === "video" && REAL_FACE.test(why)) return { level: "WARNING", statusMessage: `real-face refusal at rung ${String(s.request.mode ?? "frame")}: ${why}` };
  return { level: "ERROR", statusMessage: why };
}

export interface ObservationAttributes {
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
  level: Level;
  statusMessage?: string;
  model?: string;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
}

export interface PlannedObservation {
  /** Our span id ("root" for the trace root). */
  key: string;
  /** Key of the parent; absent only for the root. */
  parent?: string;
  name: string;
  type: ObservationType;
  startTime: Date;
  endTime: Date;
  attributes: ObservationAttributes;
}

export interface TracePlan {
  traceName: "make-video";
  sessionId: string;
  environment: "development" | "production";
  tags: string[];
  /** Root first, then the spans in file order (a parent always precedes its children). */
  observations: PlannedObservation[];
}

/** `mock` → development, `live` → production (environments docs: lowercase, ≤ 40 chars, not "langfuse…"). */
export const environmentOf = (mode: RunManifest["mode"]): TracePlan["environment"] => (mode === "live" ? "production" : "development");

/** Tags from the run and its script, so the trace list can be filtered by the kind of video. */
export function tagsOf(m: RunManifest): string[] {
  const s = m.script;
  const tags = [`mode:${m.mode}`];
  if (s && s.shots.length > 1) tags.push("storyboard");
  if (s && s.characters.length > 1) tags.push("dialogue");
  if (s?.shots.some((x) => isWide(x.camera) || x.cuts?.some((c) => isWide(c.camera)))) tags.push("wide");
  if (m.subtitles) tags.push("subtitles");
  return tags;
}

/** What a reader wants first: did it work, where is it, how long, how verbatim, how much. */
export function rootOutput(m: RunManifest): Record<string, unknown> {
  return {
    ok: m.ok,
    finalPath: m.final?.path ?? null,
    seconds: m.final ? Number(m.final.seconds.toFixed(3)) : null,
    wer: m.verbatim?.wer ?? null,
    costUsd: m.costUsd,
    ...(m.error ? { error: m.error } : {}),
  };
}

/** Spans of this process + the manifest → the observations of one trace. Pure. */
export function planTrace(spans: Span[], m: RunManifest): TracePlan {
  const start = (s: Span) => Date.parse(s.startedAt);
  const now = Date.now();
  const t0 = spans.length ? Math.min(...spans.map(start)) : now;
  const t1 = spans.length ? Math.max(...spans.map((s) => start(s) + s.ms)) : t0;
  const root: PlannedObservation = {
    key: "root",
    name: "make-video",
    type: "agent",
    startTime: new Date(t0),
    endTime: new Date(t1),
    attributes: {
      input: m.idea,
      output: rootOutput(m),
      metadata: { runId: m.runId, mode: m.mode, attempts: m.attempts.length },
      ...(m.ok ? { level: "DEFAULT" as const } : { level: "ERROR" as const, statusMessage: m.error ?? "run failed" }),
    },
  };
  const ids = new Set(spans.map((s) => s.id));
  const observations = spans.map((s): PlannedObservation => {
    const type = observationType(s);
    const metadata: Record<string, unknown> = {
      runId: s.runId,
      node: s.node,
      kind: s.kind,
      ...(s.shotId ? { shotId: s.shotId } : {}),
      ...(s.kind !== "node" ? { provider: s.provider } : {}),
      ...(typeof s.request.mode === "string" ? { mode: s.request.mode } : {}),
      ...(s.cached ? { cached: true } : {}),
    };
    const attributes: ObservationAttributes = {
      ...(s.kind !== "node" ? { input: observationInput(s) } : {}),
      output: s.response,
      metadata,
      ...levelOf(s),
    };
    if (type === "generation") {
      attributes.model = s.model ?? s.provider;
      attributes.usageDetails = usageDetails(s);
      // Our measured cost overrides Langfuse's inferred price: we know what the provider billed.
      attributes.costDetails = { total: s.costUsd };
    } else if (type === "evaluator") {
      // Evaluators carry no usage/cost fields in Langfuse; keep them readable in metadata.
      Object.assign(metadata, { model: s.model ?? s.provider, costUsd: s.costUsd, usage: usageDetails(s) });
    }
    return {
      key: s.id,
      // A parent missing from this process's spans (a call outside a node) hangs off the root.
      parent: s.parentId && ids.has(s.parentId) ? s.parentId : "root",
      name: observationName(s),
      type,
      startTime: new Date(start(s)),
      endTime: new Date(start(s) + s.ms),
      attributes,
    };
  });
  return { traceName: "make-video", sessionId: m.runId, environment: environmentOf(m.mode), tags: tagsOf(m), observations: [root, ...observations] };
}

// --- scores ---

export interface PlannedScore {
  name: string;
  value: number;
  dataType: "NUMERIC" | "BOOLEAN";
  comment?: string;
}

/** Shot of a judge span: its context, else the shot id in the judged file name (keyframes are judged in one node). */
function judgedShot(s: Span): string | undefined {
  if (s.shotId) return s.shotId;
  const img = s.request.image as { path?: unknown } | undefined;
  return typeof img?.path === "string" ? /-(s\d)-/.exec(img.path)?.[1] : undefined;
}

/** Issues the judge gave for the kept score: the last fresh verdict of that shot and kind with that score. */
function issuesFor(spans: Span[], shot: string, keyframe: boolean, score: number): string | undefined {
  const hit = spans
    .filter((s) => s.kind === "judge" && s.ok && !s.cached && isKeyframeJudge(s) === keyframe && judgedShot(s) === shot)
    .map((s) => s.response.verdict as { score?: number; issues?: string[] } | undefined)
    .filter((v) => v?.score === score)
    .at(-1);
  return hit?.issues?.length ? hit.issues.join("; ") : undefined;
}

/** Quality labels known only at run end, as trace scores. Pure. */
export function planScores(m: RunManifest, spans: Span[]): PlannedScore[] {
  const out: PlannedScore[] = [];
  if (m.verbatim) {
    out.push({ name: "verbatim_wer", value: m.verbatim.wer, dataType: "NUMERIC", ...(m.spoken ? { comment: `heard: ${m.spoken.heard}` } : {}) });
    out.push({ name: "verbatim_pass", value: m.verbatim.pass ? 1 : 0, dataType: "BOOLEAN" });
  }
  const shots = Object.entries(m.shots ?? {});
  for (const [id, shot] of shots) {
    if (!shot) continue;
    for (const [keyframe, score] of [[true, shot.keyframeScore], [false, shot.clipScore]] as const) {
      if (score === undefined) continue;
      const comment = issuesFor(spans, id, keyframe, score);
      out.push({ name: `judge_${keyframe ? "keyframe" : "clip"}_${id}`, value: score, dataType: "NUMERIC", ...(comment ? { comment } : {}) });
    }
  }
  // A script the continuity critic still objected to (F18) needs review as much as a shot below the bar.
  const review = m.script?.needsReview === true || shots.some(([, s]) => s?.needsReview);
  if (shots.length || m.script?.needsReview) out.push({ name: "needs_review", value: review ? 1 : 0, dataType: "BOOLEAN" });
  out.push({ name: "cost_usd", value: m.costUsd, dataType: "NUMERIC" });
  return out;
}

// --- export ---

/** The test seams: an in-memory OTel exporter and a fake score client. Live runs pass neither. */
export interface LangfuseTestHooks {
  /** An OTel `SpanExporter` (e.g. `InMemorySpanExporter`) used instead of Langfuse's OTLP exporter. */
  exporter?: unknown;
  scores?: ScoreClient;
}

/** The part of `LangfuseClient` we use (structural, so a fake fits). */
export interface ScoreClient {
  score: { create(s: { traceId: string; name: string; value: number; dataType: "NUMERIC" | "BOOLEAN"; comment?: string; environment?: string }): void };
  shutdown(): Promise<void>;
}

export type ExportResult = { ok: true; traceId: string } | { ok: false; error: string };

/** How many times the SDK module was loaded (acceptance 3: zero without keys). */
export let sdkLoads = 0;

/** Plans, then hands the plan to the SDK (loaded only now), which flushes and shuts down before returning. Never throws. */
export async function exportToLangfuse(
  spans: Span[],
  manifest: RunManifest,
  opts: { config: LangfuseConfig } & LangfuseTestHooks,
): Promise<ExportResult> {
  const { secretKey, publicKey } = opts.config;
  // The error goes into the manifest; an echoed key must not.
  const redact = (s: string) => s.split(secretKey).join("[redacted]").split(publicKey).join("[redacted]");
  try {
    sdkLoads++;
    const sdk = await import("./langfuse-sdk.ts");
    const r = await sdk.sendTrace(planTrace(spans, manifest), planScores(manifest, spans), opts);
    return r.ok ? r : { ok: false, error: redact(r.error) };
  } catch (e) {
    return { ok: false, error: redact(e instanceof Error ? e.message : String(e)) };
  }
}
