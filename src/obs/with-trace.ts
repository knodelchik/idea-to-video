/**
 * `withTrace(providers, sink)` (F16): the same providers, every model / paid-API method emitting one span per call,
 * in the style of `withBudget`. Requests keep full prompt and rubric text; media go in as path + sha256 only. Secrets
 * never get here: adapters hold their keys and headers privately, and the span is built only from the request and
 * the result objects.
 */
import type { CallMeta, Providers } from "../providers/index.ts";
import { clipText, fileRef, fileRefs, finalPath, linkFields, newSpanId, type CallKind, type Span, type TraceSink } from "./trace.ts";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Described {
  response: Record<string, unknown>;
  costUsd: number;
  model?: string | undefined;
  meta?: CallMeta | undefined;
}

/** Finish reason, prompt block reason and reply text of a call, as response fields. */
function metaFields(meta: CallMeta | undefined): Record<string, unknown> {
  if (!meta) return {};
  return {
    ...(meta.text !== undefined ? clipText(meta.text) : {}),
    ...(meta.finishReason ? { finishReason: meta.finishReason } : {}),
    ...(meta.promptFeedback ? { promptFeedback: meta.promptFeedback } : {}),
  };
}

const rawText = (raw: unknown): string => (typeof raw === "string" ? raw : (JSON.stringify(raw) ?? ""));

async function traced<R>(
  sink: TraceSink,
  kind: CallKind,
  provider: string,
  request: () => Promise<Record<string, unknown>>,
  call: () => Promise<R>,
  describe: (r: R) => Described,
): Promise<R> {
  const link = linkFields(); // read before any await: the context is the caller's
  const req = await request();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const base = { id: newSpanId(), ...link, kind, provider, startedAt, request: req };
  try {
    const r = await call();
    const d = describe(r);
    const span: Span = {
      ...base,
      ...(d.model ? { model: d.model } : {}),
      ms: Math.round(performance.now() - t0),
      ok: true,
      costUsd: d.costUsd,
      ...(d.meta?.usage ? { usage: d.meta.usage } : {}),
      response: { ...metaFields(d.meta), ...d.response },
    };
    sink.write(span);
    return r;
  } catch (e) {
    const err = e as { costUsd?: unknown; meta?: CallMeta; raw?: unknown } | null;
    const paid = typeof err?.costUsd === "number" ? err.costUsd : 0;
    // A judge reply that failed its schema: keep what the model said and why it stopped.
    const response = { ...(err?.raw !== undefined ? clipText(rawText(err.raw)) : {}), ...metaFields(err?.meta) };
    sink.write({
      ...base,
      ms: Math.round(performance.now() - t0),
      ok: false,
      error: errMsg(e),
      costUsd: paid,
      ...(err?.meta?.usage ? { usage: err.meta.usage } : {}),
      response,
    });
    throw e;
  }
}

/** Fields of an optional method, only when the inner provider has it (withBudget reads `estimateUsd?.`). */
function opt<K extends string, F>(key: K, f: F | undefined): Partial<Record<K, F>> {
  return f ? ({ [key]: f } as Record<K, F>) : {};
}

export function withTrace(p: Providers, sink: TraceSink): Providers {
  const { llm, tts, asr, image, video, lipsync, talking, judge } = p;
  return {
    llm: {
      name: llm.name,
      ...opt("estimateUsd", llm.estimateUsd?.bind(llm)),
      generateJson: (req) =>
        traced(
          sink,
          "llm",
          llm.name,
          async () => ({ system: req.system, prompt: req.prompt, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }),
          () => llm.generateJson(req),
          (r) => ({
            costUsd: r.costUsd,
            model: r.model,
            meta: r.meta,
            response: {
              ...(r.meta?.text === undefined ? clipText(rawText(r.raw)) : {}),
              parsed: r.ok,
              ...(r.ok ? {} : { parseError: r.error }),
              ...(r.notes?.length ? { notes: r.notes } : {}),
            },
          }),
        ),
    },
    tts: {
      name: tts.name,
      ...opt("estimateUsd", tts.estimateUsd?.bind(tts)),
      speak: (req) =>
        traced(
          sink,
          "tts",
          tts.name,
          async () => ({ text: req.text, voice: req.voice, ...(req.emotion ? { emotion: req.emotion } : {}), ...(req.variant !== undefined ? { variant: req.variant } : {}) }),
          () => tts.speak(req),
          (r) => ({
            costUsd: r.costUsd,
            model: r.provider,
            response: { path: finalPath(r.path), seconds: r.seconds, ...(r.notes?.length ? { notes: r.notes } : {}) },
          }),
        ),
    },
    asr: {
      name: asr.name,
      ...opt("estimateUsd", asr.estimateUsd?.bind(asr)),
      transcribe: (req) =>
        traced(
          sink,
          "asr",
          asr.name,
          async () => ({ media: await fileRef(req.path) }),
          () => asr.transcribe(req),
          (r) => ({ costUsd: r.costUsd, response: { ...clipText(r.text), words: r.words.length } }),
        ),
    },
    image: {
      name: image.name,
      ...opt("estimateUsd", image.estimateUsd?.bind(image)),
      generate: (req) =>
        traced(
          sink,
          "image",
          image.name,
          async () => ({ prompt: req.prompt, refs: await fileRefs(req.refs), ...(req.variant ? { variant: req.variant } : {}) }),
          () => image.generate(req),
          (r) => ({ costUsd: r.costUsd, response: { path: finalPath(r.path) } }),
        ),
    },
    video: {
      name: video.name,
      get capabilities() {
        return video.capabilities;
      },
      ...opt("estimateUsd", video.estimateUsd?.bind(video)),
      animate: (req) =>
        traced(
          sink,
          "video",
          video.name,
          async () => ({
            prompt: req.prompt,
            seconds: req.seconds,
            mode: req.mode ?? (req.textOnly ? "text" : "frame"),
            ...(req.line !== undefined ? { line: req.line } : {}),
            ...(req.textOnly ? {} : { image: await fileRef(req.image) }),
            refs: await fileRefs(req.refs),
            ...(req.variant !== undefined ? { variant: req.variant } : {}),
          }),
          () => video.animate(req),
          (r) => ({ costUsd: r.costUsd, response: { path: finalPath(r.path), seconds: r.seconds, hasAudio: r.hasAudio } }),
        ),
    },
    lipsync: {
      name: lipsync.name,
      get maxSeconds() {
        return lipsync.maxSeconds;
      },
      ...opt("estimateUsd", lipsync.estimateUsd?.bind(lipsync)),
      sync: (req) =>
        traced(
          sink,
          "lipsync",
          lipsync.name,
          async () => ({ video: await fileRef(req.video), audio: await fileRef(req.audio) }),
          () => lipsync.sync(req),
          (r) => ({ costUsd: r.costUsd, response: { path: finalPath(r.path) } }),
        ),
    },
    talking: {
      name: talking.name,
      ...opt("estimateUsd", talking.estimateUsd?.bind(talking)),
      // An audio-driven avatar is a video model: traced as kind "video", mode "talking".
      talk: (req) =>
        traced(
          sink,
          "video",
          talking.name,
          async () => ({ prompt: req.prompt, mode: "talking", image: await fileRef(req.image), audio: await fileRef(req.audio) }),
          () => talking.talk(req),
          (r) => ({ costUsd: r.costUsd, response: { path: finalPath(r.path) } }),
        ),
    },
    judge: {
      name: judge.name,
      ...opt("estimateUsd", judge.estimateUsd?.bind(judge)),
      judgeImage: (req) =>
        traced(
          sink,
          "judge",
          judge.name,
          async () => ({ rubric: req.rubric, image: await fileRef(req.path), refs: await fileRefs(req.refs) }),
          () => judge.judgeImage(req),
          (r) => judged(r),
        ),
      judgeVideo: (req) =>
        traced(
          sink,
          "judge",
          judge.name,
          async () => ({
            rubric: req.rubric,
            frames: await fileRefs(req.frames),
            refs: await fileRefs(req.refs),
            ...(req.video ? { video: await fileRef(req.video) } : {}),
            ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
          }),
          () => judge.judgeVideo(req),
          (r) => judged(r),
        ),
    },
  };
}

function judged(r: Awaited<ReturnType<Providers["judge"]["judgeImage"]>>): Described {
  return {
    costUsd: r.costUsd,
    model: r.model,
    meta: r.meta,
    response: { verdict: { score: r.score, issues: r.issues }, ...(r.notes?.length ? { notes: r.notes } : {}) },
  };
}
