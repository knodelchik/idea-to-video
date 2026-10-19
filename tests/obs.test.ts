import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemorySpanExporter, NodeTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, secretsFromEnv } from "../src/cli.ts";
import { LANGFUSE_EU_HOST, langfuseFromEnv, OBSERVATION_NAMES, sdkLoads, type ScoreClient } from "../src/obs/langfuse.ts";
import { loadRuns, main as metricsMain, parseTrace } from "../src/obs/metrics-cli.ts";
import { metrics, normaliseReason } from "../src/obs/metrics.ts";
import { clipText, finalPath, JsonlSink, MemorySink, TEXT_LIMIT, withTraceContext, type Span } from "../src/obs/trace.ts";
import { withTrace } from "../src/obs/with-trace.ts";
import {
  createProviders,
  GeminiJudge,
  JudgeOutputError,
  MockJudge,
  MockVideo,
  type FetchLike,
} from "../src/providers/index.ts";
import { RunManifest } from "../src/schemas.ts";

const LINE = "I kept the watch. I kept everything.";
const IDEA = `A man on a rooftop calls his brother. He says: "${LINE}"`;
const SLOW = 120_000;
const FIXTURES = join(import.meta.dirname, "fixtures", "metrics");
/** Fake credentials: a mock run must never write them anywhere in its trace. */
const FAKE_ENV = {
  GEMINI_API_KEY: "AIzaFAKE-gemini-key-0123456789",
  FAL_KEY: "fal-FAKE-key-abcdef0123456789",
  GROQ_API_KEY: "gsk_FAKE_groq_key_0123456789",
  ELEVENLABS_API_KEY: "el-FAKE-key-9876543210",
};
const LF_ENV = { LANGFUSE_PUBLIC_KEY: "pk-lf-test-0123456789", LANGFUSE_SECRET_KEY: "sk-lf-test-9876543210" };
const attr = (s: ReadableSpan, key: string): unknown => s.attributes[key];
/** Langfuse attributes hold JSON, except a plain string input/output, which the SDK stores as is. */
const json = (s: ReadableSpan, key: string): unknown => {
  const v = s.attributes[key];
  if (typeof v !== "string") return undefined;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
};

/** A fake `LangfuseClient`: records scores, counts shutdowns (a plain counter: mock state is reset between tests). */
function fakeScores() {
  const created: Parameters<ScoreClient["score"]["create"]>[0][] = [];
  const state = { shutdowns: 0 };
  const client: ScoreClient = {
    score: { create: (s) => void created.push(s) },
    shutdown: async () => {
      state.shutdowns++;
    },
  };
  return { client, created, state };
}

/** `InMemorySpanExporter.shutdown()` clears what it holds, and the export always shuts down: keep the spans to assert. */
class KeptSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** An exporter whose every export fails, the way an OTLP 500 does. */
class FailingExporter extends InMemorySpanExporter {
  override export(_spans: ReadableSpan[], cb: (r: { code: number; error?: Error }) => void): void {
    cb({ code: 1, error: new Error(`OTLP export failed: 500 for key ${LF_ENV.LANGFUSE_SECRET_KEY}`) });
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "itv-obs-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Summary {
  ok: boolean;
  runId: string;
  manifest: string;
}

async function cli(argv: string[], deps: Parameters<typeof main>[1] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, "--json"], {
    runsDir: join(dir, "runs"),
    env: {},
    retry: { initialInterval: 1, jitter: false },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...deps,
  });
  const json = JSON.parse(out.at(-1)!) as Summary;
  const manifest = RunManifest.parse(JSON.parse(await readFile(json.manifest, "utf8")));
  const tracePath = join(dir, "runs", json.runId, "trace.jsonl");
  const traceText = await readFile(tracePath, "utf8");
  return { code, json, err, manifest, traceText, spans: parseTrace(traceText) };
}

// --- trace ---

describe("trace: a mock CLI run writes runs/<id>/trace.jsonl", () => {
  let run: Awaited<ReturnType<typeof cli>>;
  let video: MockVideo;
  let judge: MockJudge;
  /** What the Langfuse SDK exported (F17): the OTel spans, as Langfuse would receive them. */
  const exporter = new KeptSpanExporter();
  const scores = fakeScores();
  let flushedBeforeExit = { forceFlush: 0, shutdown: 0 };

  // One full pipeline run for the whole file (ffmpeg-heavy; more runs starve the parallel suites). It has fake API
  // keys (F16 acceptance 2) and Langfuse keys; the redos below cover "no keys" and "Langfuse 500" cheaply.
  beforeAll(async () => {
    video = new MockVideo();
    judge = new MockJudge();
    const forceFlush = vi.spyOn(NodeTracerProvider.prototype, "forceFlush");
    const shutdown = vi.spyOn(NodeTracerProvider.prototype, "shutdown");
    try {
      run = await cli([IDEA, "--mock"], { env: { ...FAKE_ENV, ...LF_ENV }, overrides: { video, judge }, langfuse: { exporter, scores: scores.client } });
      // Counted the moment main() returned: the CLI may exit right after.
      flushedBeforeExit = { forceFlush: forceFlush.mock.calls.length, shutdown: shutdown.mock.calls.length };
    } finally {
      forceFlush.mockRestore();
      shutdown.mockRestore();
    }
    expect(run.code).toBe(0);
  }, SLOW);

  it("1. every provider call has a span with runId, node, kind, provider, ms, ok and cost", () => {
    const calls = run.spans.filter((s) => s.kind !== "node");
    expect(calls.length).toBeGreaterThan(0);
    for (const s of calls) {
      expect(s.runId).toBe(run.json.runId);
      expect(typeof s.node).toBe("string");
      expect(s.node).not.toBe("(none)");
      expect(["llm", "image", "video", "tts", "asr", "judge", "lipsync"]).toContain(s.kind);
      expect(s.provider).toMatch(/^mock-/);
      expect(typeof s.ms).toBe("number");
      expect(typeof s.ok).toBe("boolean");
      expect(typeof s.costUsd).toBe("number");
    }
    // Each capability the mock pipeline uses shows up.
    expect(new Set(calls.map((s) => s.kind))).toEqual(new Set(["llm", "image", "video", "asr", "judge"]));
    // One span per real call: video spans match the calls the mock received.
    expect(calls.filter((s) => s.kind === "video" && !s.cached)).toHaveLength(video.calls.length);
  });

  it("1. shot spans carry shotId; node spans are the parents", () => {
    const nodes = new Map(run.spans.filter((s) => s.kind === "node").map((s) => [s.id, s]));
    expect([...nodes.values()].map((s) => s.node)).toEqual(
      expect.arrayContaining(["writeScript", "cast", "drawKeyframes", "shot", "assemble", "burnSubtitles", "finalGate"]),
    );
    for (const s of run.spans.filter((x) => x.kind !== "node")) {
      const parent = nodes.get(s.parentId ?? "");
      expect(parent, `${s.kind} span ${s.id} has a node parent`).toBeDefined();
      expect(parent!.node).toBe(s.node);
      expect(parent!.runId).toBe(s.runId);
    }
    const shotSpans = run.spans.filter((s) => s.node === "shot");
    expect(shotSpans.length).toBeGreaterThan(0);
    for (const s of shotSpans) expect(s.shotId).toMatch(/^s\d+$/);
    expect(new Set(shotSpans.filter((s) => s.kind === "video").map((s) => s.shotId)).size).toBe(video.calls.length);
  });

  it("1. the judge span holds the full rubric; the video span holds the prompt and the ladder mode", () => {
    const judged = run.spans.filter((s) => s.kind === "judge" && !s.cached);
    expect(judged).toHaveLength(judge.calls.length);
    const rubrics = judge.calls.map((c) => c.rubric);
    for (const s of judged) {
      expect(rubrics).toContain(s.request.rubric);
      expect((s.request.rubric as string).length).toBeGreaterThan(200);
      expect((s.response.verdict as { score: number }).score).toBeGreaterThan(0);
    }
    const videos = run.spans.filter((s) => s.kind === "video" && !s.cached);
    for (const s of videos) {
      const call = video.calls.find((c) => c.prompt === s.request.prompt);
      expect(call, "span prompt is the full prompt sent").toBeDefined();
      expect(s.request.mode).toBe("frame");
      expect(s.request.seconds).toBe(call!.seconds);
      // Media as path + sha256, never bytes.
      expect(s.request.image).toMatchObject({ path: call!.image, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(s.response.path).toMatch(/clip-s\d+-[0-9a-f]{16}\.mp4$/); // the final name, not the tmp file
    }
  });

  it("2. secrets: with fake keys in env, no span line contains them; no base64 media either", () => {
    for (const v of [...Object.values(FAKE_ENV), ...Object.values(LF_ENV)]) expect(run.traceText).not.toContain(v);
    for (const line of run.traceText.trim().split("\n")) expect(line.length).toBeLessThan(64 * 1024);
  });

  // --- F17: Langfuse through the SDK, checked on the OTel spans it exported ---

  const exported = () => exporter.getFinishedSpans();
  const typeOf = (s: ReadableSpan) => attr(s, "langfuse.observation.type");
  const rootOf = () => exported().find((s) => attr(s, "langfuse.observation.type") === "agent")!;

  it("F17 1. one trace; the root is an agent named make-video, input = the idea, output has ok", () => {
    const spans = exported();
    expect(spans.length).toBe(run.spans.length + 1);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const root = rootOf();
    expect(root.name).toBe("make-video");
    expect(root.parentSpanContext).toBeUndefined();
    expect(json(root, "langfuse.observation.input")).toBe(IDEA);
    expect(json(root, "langfuse.observation.output")).toMatchObject({ ok: true, finalPath: run.manifest.final!.path, wer: 0, costUsd: 0 });
    expect(json(root, "langfuse.trace.input")).toBe(IDEA);
    // Trace-level attributes: name, session = run id (a --redo lands in the same session), tags from the script.
    for (const s of spans.filter((x) => typeOf(x) !== "event")) {
      expect(attr(s, "langfuse.trace.name")).toBe("make-video");
      expect(attr(s, "session.id")).toBe(run.json.runId);
    }
    expect(attr(root, "langfuse.trace.tags")).toEqual(expect.arrayContaining(["mode:mock", "subtitles"]));
  });

  it("F17 1. names come only from the stable list: no digits, no provider or model names", () => {
    const names = new Set(exported().map((s) => s.name));
    for (const n of names) {
      expect(OBSERVATION_NAMES).toContain(n);
      expect(n).not.toMatch(/\d|mock|gemini|seedance|groq|fal/);
    }
    expect(names).toEqual(new Set(["make-video", "write-script", "cast-portraits", "draw-keyframes", "render-shot", "generate-image", "generate-video", "transcribe-audio", "judge-keyframe", "judge-clip", "assemble", "burn-subtitles", "final-gate"]));
    // What the names used to carry is in metadata now.
    const shot = exported().find((s) => s.name === "generate-video")!;
    expect(json(shot, "langfuse.observation.metadata.shotId")).toMatch(/^s\d$/);
    expect(json(shot, "langfuse.observation.metadata.provider")).toBe("mock-video");
    expect(json(shot, "langfuse.observation.metadata.mode")).toBe("frame");
    expect(json(shot, "langfuse.observation.metadata.runId")).toBe(run.json.runId);
  });

  it("F17 1. types: judges are evaluators, nodes spans, the final gate a guardrail, model calls generations", () => {
    const spans = exported();
    for (const s of spans.filter((x) => x.name.startsWith("judge-"))) expect(typeOf(s)).toBe("evaluator");
    expect(typeOf(spans.find((s) => s.name === "final-gate")!)).toBe("guardrail");
    for (const n of ["write-script", "cast-portraits", "draw-keyframes", "render-shot", "assemble", "burn-subtitles"]) {
      const nodes = spans.filter((s) => s.name === n && typeOf(s) !== "generation");
      expect(nodes.length, n).toBeGreaterThan(0);
      for (const s of nodes) expect(typeOf(s)).toBe("span");
    }
    for (const n of ["generate-image", "generate-video", "transcribe-audio"]) for (const s of spans.filter((x) => x.name === n)) expect(typeOf(s)).toBe("generation");
    // Nodes hang off the root; calls off their node.
    const root = rootOf();
    for (const s of spans.filter((x) => typeOf(x) === "span" || typeOf(x) === "guardrail")) expect(s.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it("F17 1. generations carry the model, usage and cost; LLM input is role-labelled messages", () => {
    const gens = exported().filter((s) => typeOf(s) === "generation");
    expect(gens.length).toBeGreaterThan(0);
    for (const g of gens) {
      expect(attr(g, "langfuse.observation.model.name"), g.name).toEqual(expect.any(String));
      expect(Object.keys(json(g, "langfuse.observation.usage_details") as object).length, `${g.name} usage`).toBeGreaterThan(0);
      expect(json(g, "langfuse.observation.cost_details")).toEqual({ total: 0 });
    }
    const llm = gens.find((g) => g.name === "write-script")!;
    expect(json(llm, "langfuse.observation.usage_details")).toEqual({ input: expect.any(Number), output: expect.any(Number) });
    const messages = json(llm, "langfuse.observation.input") as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content.length).toBeGreaterThan(0);
    const clip = gens.find((g) => g.name === "generate-video")!;
    expect(json(clip, "langfuse.observation.usage_details")).toEqual({ video_seconds: expect.any(Number) });
    // Media as file metadata, never bytes.
    expect(json(clip, "langfuse.observation.input")).toMatchObject({ image: { type: "file", contentType: "image/png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const judged = exported().find((s) => s.name === "judge-clip")!;
    const jm = json(judged, "langfuse.observation.input") as { role: string; content: unknown }[];
    expect(jm[0]).toMatchObject({ role: "system", content: expect.stringMatching(/.{200}/s) });
    expect(jm[1]!.role).toBe("user");
  });

  it("F17 1. environment is development for mock; no secret reaches Langfuse", () => {
    for (const s of exported()) expect(attr(s, "langfuse.environment")).toBe("development");
    const all = JSON.stringify(exported().map((s) => s.attributes));
    for (const v of [...Object.values(FAKE_ENV), ...Object.values(LF_ENV)]) expect(all).not.toContain(v);
    expect(all).not.toMatch(/authorization|base64,/i);
    expect(run.manifest.notes).toBeUndefined();
  });

  it("F17 2. scores: verbatim_wer, verbatim_pass, judge_clip_s1, cost_usd on the exported trace", () => {
    const traceId = rootOf().spanContext().traceId;
    const byName = new Map(scores.created.map((s) => [s.name, s]));
    expect(byName.get("verbatim_wer")).toMatchObject({ traceId, value: 0, dataType: "NUMERIC" });
    expect(byName.get("verbatim_pass")).toMatchObject({ traceId, value: 1, dataType: "BOOLEAN" });
    expect(byName.get("judge_clip_s1")).toMatchObject({ traceId, value: run.manifest.shots!.s1!.clipScore, dataType: "NUMERIC" });
    expect(byName.get("cost_usd")).toMatchObject({ traceId, value: 0, dataType: "NUMERIC" });
    expect(byName.get("needs_review")).toMatchObject({ dataType: "BOOLEAN" });
    for (const s of scores.created) expect(s.environment).toBe("development");
  });

  it("F17 4. the CLI flushes and shuts the SDK down before main() returns", () => {
    expect(flushedBeforeExit.forceFlush).toBeGreaterThanOrEqual(1);
    expect(flushedBeforeExit.shutdown).toBeGreaterThanOrEqual(1);
    expect(scores.state.shutdowns).toBe(1);
  });

  it(
    "a failed Langfuse export (OTLP 500) leaves the run ok, with a redacted note in the manifest",
    async () => {
      const redone = await cli(["--resume", run.json.runId, "--redo", "finalGate"], { env: LF_ENV, langfuse: { exporter: new FailingExporter(), scores: fakeScores().client } });
      expect(redone.code).toBe(0);
      expect(redone.manifest.ok).toBe(true);
      expect(redone.manifest.notes).toEqual([expect.stringMatching(/^langfuse export failed \(non-fatal\): .*500/)]);
      expect(redone.manifest.notes![0]).not.toContain(LF_ENV.LANGFUSE_SECRET_KEY);
      expect(redone.err.some((l) => /langfuse export failed/.test(l))).toBe(true);
    },
    SLOW,
  );

  it(
    "4. --redo shot appends spans with cached: true for the reused clips (F17 3. without keys: no SDK, no network)",
    async () => {
      const prev = parseTrace(await readFile(join(dir, "runs", run.json.runId, "trace.jsonl"), "utf8"));
      const before = prev.length;
      const again = new MockVideo();
      const loads = sdkLoads;
      const net = vi.spyOn(globalThis, "fetch");
      const unused = new KeptSpanExporter();
      let redone: Awaited<ReturnType<typeof cli>>;
      try {
        redone = await cli(["--resume", run.json.runId, "--redo", "shot"], { overrides: { video: again }, env: FAKE_ENV, langfuse: { exporter: unused } });
        expect(net).not.toHaveBeenCalled();
      } finally {
        net.mockRestore();
      }
      expect(sdkLoads).toBe(loads);
      expect(unused.getFinishedSpans()).toHaveLength(0);
      expect(redone.code).toBe(0);
      expect(again.calls).toHaveLength(0);
      expect(redone.manifest.notes).toBeUndefined();
      // Appended: the first process's spans are all still there, in order.
      expect(redone.spans.slice(0, before)).toEqual(prev);
      expect(prev.slice(0, run.spans.length)).toEqual(run.spans);
      const added = redone.spans.slice(before);
      const reused = added.filter((s) => s.kind === "video");
      expect(reused.length).toBe(video.calls.length);
      for (const s of reused) {
        expect(s).toMatchObject({ cached: true, costUsd: 0, ok: true, node: "shot", runId: run.json.runId });
        expect(s.shotId).toMatch(/^s\d+$/);
        expect(s.request.prompt).toEqual(expect.any(String));
        expect(s.request.mode).toBe("frame");
      }
      // The reused judge verdicts are traced as reuse too.
      expect(added.some((s) => s.kind === "judge" && s.cached)).toBe(true);
    },
    SLOW,
  );
});

describe("trace: provider wrapper and sink", () => {
  it("3. an empty judge reply with a finishReason (fake Gemini client) → span with text \"\" and the finish reason", async () => {
    const img = join(dir, "frame.png");
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const client = {
      models: {
        generateContent: async () => ({
          text: "",
          candidates: [{ finishReason: "MAX_TOKENS" }],
          usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 0, thoughtsTokenCount: 3990 },
        }),
      },
    };
    const sink = new MemorySink();
    const judge = new GeminiJudge({ client, models: ["gemini-3.5-flash"] });
    const p = withTrace(createProviders({ mode: "mock", env: {}, overrides: { judge } }), sink);
    const rubric = "Judge this keyframe. ".repeat(30);
    const err = await withTraceContext({ runId: "r1", node: "drawKeyframes", parentId: "abc" }, () =>
      p.judge.judgeImage({ path: img, rubric }).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(JudgeOutputError);
    expect(sink.spans).toHaveLength(1);
    const s = sink.spans[0]!;
    expect(s).toMatchObject({ kind: "judge", provider: "gemini-judge", ok: false, runId: "r1", node: "drawKeyframes", parentId: "abc" });
    expect(s.response.text).toBe("");
    expect(s.response.finishReason).toBe("MAX_TOKENS");
    expect(s.request.rubric).toBe(rubric);
    expect(s.costUsd).toBeGreaterThan(0); // the thinking tokens were paid for
    expect(s.usage).toEqual({ input: 2000, output: 0, thinking: 3990 });
    expect(s.error).toMatch(/judge output invalid/);
  });

  it("a blocked prompt is traced with its promptFeedback; a good reply with its text and model", async () => {
    const img = join(dir, "frame2.png");
    await writeFile(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    let reply: object = { text: "", promptFeedback: { blockReason: "SAFETY" } };
    const client = { models: { generateContent: async () => reply } };
    const sink = new MemorySink();
    const p = withTrace(createProviders({ mode: "mock", env: {}, overrides: { judge: new GeminiJudge({ client, models: ["gemini-3.5-flash"] }) } }), sink);
    await p.judge.judgeImage({ path: img, rubric: "r" }).catch(() => undefined);
    expect(sink.spans[0]!.response.promptFeedback).toBe("SAFETY");
    reply = { text: '{"score":8,"issues":[]}', candidates: [{ finishReason: "STOP" }] };
    await p.judge.judgeImage({ path: img, rubric: "r" });
    expect(sink.spans[1]).toMatchObject({ ok: true, model: "gemini-3.5-flash", response: { text: '{"score":8,"issues":[]}', finishReason: "STOP", verdict: { score: 8, issues: [] } } });
  });

  it("reply text is capped at 4 kB with its length; tmp names map to the final artifact name", () => {
    expect(clipText("short")).toEqual({ text: "short" });
    const long = clipText("x".repeat(TEXT_LIMIT + 10));
    expect(long.text).toHaveLength(TEXT_LIMIT);
    expect(long).toMatchObject({ textLength: TEXT_LIMIT + 10, truncated: true });
    expect(finalPath("/r/clip-s1-abcd.tmp-123-0a1b2c3d.mp4")).toBe("/r/clip-s1-abcd.mp4");
    expect(finalPath("/r/judge.tmp-9-deadbeef.json")).toBe("/r/judge.json");
    expect(finalPath("/r/plain.mp4")).toBe("/r/plain.mp4");
  });

  it("the JSONL sink redacts known secret values and appends one parseable line per span", async () => {
    const path = join(dir, "sink", "trace.jsonl");
    const sink = new JsonlSink(path, ["super-secret-value-123", "short"]);
    const span: Span = {
      id: "1",
      runId: "r",
      node: "n",
      kind: "llm",
      provider: "p",
      startedAt: new Date().toISOString(),
      ms: 1,
      ok: false,
      error: "401 for key super-secret-value-123",
      costUsd: 0,
      request: { prompt: "short words stay" },
      response: {},
    };
    sink.write(span);
    sink.write({ ...span, id: "2" });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("super-secret-value-123");
    expect(text).toContain("[redacted]");
    expect(text).toContain("short words stay"); // values under 8 chars are not treated as secrets
    expect(parseTrace(text).map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("secretsFromEnv picks credential-looking variables only", () => {
    expect(secretsFromEnv({ ...FAKE_ENV, MAX_COST_USD: "3", LANGFUSE_SECRET_KEY: "sk-lf-0123456789", HOME: "/Users/x" }).sort()).toEqual(
      [...Object.values(FAKE_ENV), "sk-lf-0123456789"].sort(),
    );
  });
});

// --- metrics ---

describe("metrics across runs", () => {
  it("5. metrics() on a fixture dir of 3 manifests gives the expected numbers", async () => {
    const { records, skipped } = await loadRuns(FIXTURES);
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(3);
    const m = metrics(records);
    expect(m.runs).toBe(3);
    expect(m.traced).toBe(1);
    expect(m.successRate).toBe(0.6667);
    expect(m.totalCostUsd).toBe(1.8);
    expect(m.costPerVideoUsd).toBe(0.6);
    expect(m.costPerSuccessUsd).toBe(0.9);
    expect(m.finalWerZeroRate).toBe(0.6667);
    // Run a's real-face refusal is a failed video take, so it is not a first take (same rule as evals).
    expect(m.verbatimFirstTakeRate).toBe(0);
    expect(m.fallbacks.realFaceRefusals).toBe(3);
    expect(m.fallbacks.ladderRungs).toEqual({ refs: 1, portraits: 1, text: 1 });
    expect(m.fallbacks.ignoredInSilence).toEqual({ words: 4, runs: 1 });
    expect(m.fallbacks.silentShotSpeechDropped).toBe(1);
    expect(m.fallbacks.shotAudio).toEqual({ native: 1, fallback: 1, voiceover: 0, silent: 2 });
    expect(m.fallbacks.ttsRate).toBe(0.5);
    expect(m.judge).toEqual({ scores: { "8": 1 }, mean: 8, failures: 1, needsReviewRate: 0.3333 });
    expect(m.attemptsPerStage.video).toEqual({ total: 9, meanPerRun: 3 });
    expect(m.attemptsPerStage.retry).toEqual({ total: 1, meanPerRun: 0.333 });
    // Wall time per run: run a from its trace (80 s), b and c from summed attempt ms.
    expect(m.wallMs.run).toEqual({ p50: 80_000, p90: 207_700, n: 3 });
    expect(m.wallMs.stage.shot).toEqual({ p50: 75_000, p90: 75_000, n: 1 });
    expect(m.modelCalls).toEqual([
      { provider: "gemini", model: "gemini-3.8-flash", calls: 1, cached: 0, failed: 0, inputTokens: 1000, outputTokens: 700, costUsd: 0.02 },
      { provider: "gemini-judge", model: "gemini-3.5-flash", calls: 1, cached: 0, failed: 0, inputTokens: 3000, outputTokens: 100, costUsd: 0.009 },
      { provider: "seedance", model: "-", calls: 1, cached: 1, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
    expect(m.topFailures[0]).toEqual({ reason: normaliseReason("video: video error: HTTP 500 from https://api.example.com/v1/jobs/1"), count: 2 });
  });

  it("normaliseReason folds numbers, quotes, paths and ids", () => {
    expect(normaliseReason('Sub "a" heard as "b" in /runs/x/clip-s1-0123456789abcdef.mp4 at 3.5 s')).toBe(
      'sub "…" heard as "…" in <path> at # s',
    );
  });

  it(
    "5. pnpm metrics prints them",
    async () => {
      const out: string[] = [];
      expect(await metricsMain([FIXTURES], (l) => out.push(l))).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("runs 3 (traced 1), success 67%");
      expect(text).toContain("per video $0.6000, per successful video $0.9000");
      expect(text).toContain("ladder rungs: refs 1, portraits 1, text 1");
      expect(text).toContain("ASR words ignored in silence 4 (in 1 runs)");
      // The real entry point behind `pnpm metrics`, as a process.
      const root = join(import.meta.dirname, "..");
      const { stdout } = await promisify(execFile)(join(root, "node_modules", ".bin", "tsx"), ["src/obs/metrics-cli.ts", FIXTURES, "--json"], { cwd: root });
      const parsed = JSON.parse(stdout) as { runs: number; costPerVideoUsd: number };
      expect(parsed).toMatchObject({ runs: 3, costPerVideoUsd: 0.6 });
    },
    SLOW,
  );
});

// --- Langfuse ---

describe("Langfuse export", () => {
  it("is off unless both keys are set; the host defaults to the EU cloud", () => {
    expect(langfuseFromEnv({})).toBeUndefined();
    expect(langfuseFromEnv({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeUndefined();
    expect(langfuseFromEnv({ LANGFUSE_SECRET_KEY: "sk" })).toBeUndefined();
    expect(langfuseFromEnv(LF_ENV)).toEqual({ publicKey: LF_ENV.LANGFUSE_PUBLIC_KEY, secretKey: LF_ENV.LANGFUSE_SECRET_KEY, baseUrl: LANGFUSE_EU_HOST });
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_HOST: "https://us.cloud.langfuse.com/" })?.baseUrl).toBe("https://us.cloud.langfuse.com");
    // The current SDK's name wins, so a self-hosted URL set as LANGFUSE_BASE_URL is used (live 2026-10-19: a 401 from the cloud).
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_BASE_URL: "https://lf.example.test/" })?.baseUrl).toBe("https://lf.example.test");
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_BASE_URL: "https://lf.example.test", LANGFUSE_HOST: "https://old.example.test" })?.baseUrl).toBe("https://lf.example.test");
  });
});
