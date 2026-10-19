import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, secretsFromEnv } from "../src/cli.ts";
import { exportToLangfuse, LANGFUSE_EU_HOST, langfuseFromEnv, OTLP_PATH, otelTraceId, toOtlp, type OtlpBody } from "../src/obs/langfuse.ts";
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
const attr = (s: OtlpBody["resourceSpans"][number]["scopeSpans"][number]["spans"][number], key: string) =>
  s.attributes.find((a) => a.key === key)?.value as { stringValue?: string } | undefined;

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

/** A fetch that records calls and answers with `status`. */
function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 200 ? "{}" : "internal error", { status });
  };
  return { f, calls };
}

// --- trace ---

describe("trace: a mock CLI run writes runs/<id>/trace.jsonl", () => {
  let run: Awaited<ReturnType<typeof cli>>;
  let video: MockVideo;
  let judge: MockJudge;
  const fetch = fakeFetch();

  // One full pipeline run for the whole file (ffmpeg-heavy; more runs starve the parallel suites). It has fake API
  // keys (acceptance 2) and Langfuse keys (acceptance 6); the redos below cover "no keys" and "Langfuse 500" cheaply.
  beforeAll(async () => {
    video = new MockVideo();
    judge = new MockJudge();
    run = await cli([IDEA, "--mock"], { env: { ...FAKE_ENV, ...LF_ENV }, overrides: { video, judge }, fetch: fetch.f });
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

  it("6. with keys: one batched POST to the ingestion endpoint holds a trace, node spans and generations", () => {
    expect(fetch.calls).toHaveLength(1);
    const { url, init } = fetch.calls[0]!;
    expect(url).toBe(`${LANGFUSE_EU_HOST}${OTLP_PATH}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`${LF_ENV.LANGFUSE_PUBLIC_KEY}:${LF_ENV.LANGFUSE_SECRET_KEY}`).toString("base64")}`);
    const body = JSON.parse(init.body as string) as OtlpBody;
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    // Exactly one trace: every span shares the run's trace id; the root carries the trace name.
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([otelTraceId(run.json.runId)]));
    const root = spans.find((s) => s.parentSpanId === undefined)!;
    expect(attr(root, "langfuse.trace.name")?.stringValue).toBe("idea-to-video");
    const type = (t: string) => spans.filter((s) => attr(s, "langfuse.observation.type")?.stringValue === t);
    const nodes = type("span").filter((s) => s !== root);
    const gens = type("generation");
    expect(nodes.length).toBe(run.spans.filter((s) => s.kind === "node").length);
    expect(gens.length).toBe(run.spans.filter((s) => s.kind !== "node").length);
    for (const n of nodes) expect(n.parentSpanId).toBe(root.spanId);
    const nodeIds = new Set(nodes.map((n) => n.spanId));
    for (const g of gens) {
      expect(nodeIds.has(g.parentSpanId!)).toBe(true);
      expect(attr(g, "langfuse.observation.model.name")?.stringValue).toMatch(/^mock-/);
      expect(JSON.parse(attr(g, "langfuse.observation.cost_details")!.stringValue!)).toEqual({ total: 0 });
    }
    // The keys go in the header only, never in the body.
    expect(init.body as string).not.toContain(LF_ENV.LANGFUSE_SECRET_KEY);
    expect(run.manifest.notes).toBeUndefined();
  });

  it(
    "6. a 500 from Langfuse leaves the run ok, with a note in the manifest",
    async () => {
      const down = fakeFetch(500);
      const redone = await cli(["--resume", run.json.runId, "--redo", "finalGate"], { env: LF_ENV, fetch: down.f });
      expect(down.calls).toHaveLength(1);
      expect(redone.code).toBe(0);
      expect(redone.manifest.ok).toBe(true);
      expect(redone.manifest.notes).toEqual([expect.stringMatching(/^langfuse export failed \(non-fatal\): HTTP 500/)]);
      expect(redone.err.some((l) => /langfuse export failed/.test(l))).toBe(true);
    },
    SLOW,
  );

  it(
    "4. --redo shot appends spans with cached: true for the reused clips (6. without keys: fetch never called)",
    async () => {
      const prev = parseTrace(await readFile(join(dir, "runs", run.json.runId, "trace.jsonl"), "utf8"));
      const before = prev.length;
      const again = new MockVideo();
      const off = fakeFetch();
      const redone = await cli(["--resume", run.json.runId, "--redo", "shot"], { overrides: { video: again }, env: FAKE_ENV, fetch: off.f });
      expect(redone.code).toBe(0);
      expect(again.calls).toHaveLength(0);
      expect(off.calls).toHaveLength(0);
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
    expect(langfuseFromEnv(LF_ENV)).toEqual({ publicKey: LF_ENV.LANGFUSE_PUBLIC_KEY, secretKey: LF_ENV.LANGFUSE_SECRET_KEY, host: LANGFUSE_EU_HOST });
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_HOST: "https://us.cloud.langfuse.com/" })?.host).toBe("https://us.cloud.langfuse.com");
    // The current SDK's name wins, so a self-hosted URL set as LANGFUSE_BASE_URL is used (live 2026-10-19: a 401 from the cloud).
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_BASE_URL: "https://lf.example.test/" })?.host).toBe("https://lf.example.test");
    expect(langfuseFromEnv({ ...LF_ENV, LANGFUSE_BASE_URL: "https://lf.example.test", LANGFUSE_HOST: "https://old.example.test" })?.host).toBe("https://lf.example.test");
  });

  it("generations carry usage; a network error is a result, not a throw; an echoed key is redacted", async () => {
    const span: Span = {
      id: "0123456789abcdef",
      parentId: "fedcba9876543210",
      runId: "r",
      node: "writeScript",
      kind: "llm",
      provider: "gemini",
      model: "gemini-3.8-flash",
      startedAt: "2026-10-19T10:00:00.000Z",
      ms: 1500,
      ok: true,
      costUsd: 0.01,
      usage: { input: 10, output: 20, thinking: 5 },
      request: { prompt: "p" },
      response: { text: "{}" },
    };
    const body = toOtlp([span], { runId: "r" });
    const gen = body.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
    expect(JSON.parse(attr(gen, "langfuse.observation.usage_details")!.stringValue!)).toEqual({ input: 10, output: 20, thinking: 5 });
    expect(attr(gen, "langfuse.observation.model.name")?.stringValue).toBe("gemini-3.8-flash");
    expect(gen.endTimeUnixNano).toBe(String((Date.parse(span.startedAt) + 1500) * 1_000_000));
    // Parent not in the batch → hangs off the root.
    expect(gen.parentSpanId).toBe(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId);

    const config = langfuseFromEnv(LF_ENV)!;
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await exportToLangfuse([span], { runId: "r", config, fetch: down })).toEqual({ ok: false, error: "fetch failed" });
    const echo: FetchLike = async () => new Response(`bad key ${LF_ENV.LANGFUSE_SECRET_KEY}`, { status: 401 });
    const r = await exportToLangfuse([span], { runId: "r", config, fetch: echo });
    expect(r).toEqual({ ok: false, error: "HTTP 401: bad key [redacted]" });
  });
});
