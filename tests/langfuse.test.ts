/**
 * F17: the Langfuse mapping on hand-built spans (no pipeline run): errors, real-face warnings, cached events, live
 * environment and tags, generation model/usage/cost, score comments. Exported through the real SDK into an OTel
 * `InMemorySpanExporter`; the end-to-end mock run is checked in obs.test.ts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it, vi } from "vitest";
import { exportToLangfuse, langfuseFromEnv, planScores, planTrace, tagsOf, type ScoreClient } from "../src/obs/langfuse.ts";
import type { Span } from "../src/obs/trace.ts";
import { RunManifest } from "../src/schemas.ts";

const config = langfuseFromEnv({ LANGFUSE_PUBLIC_KEY: "pk-lf-unit-0123456789", LANGFUSE_SECRET_KEY: "sk-lf-unit-9876543210" })!;
const FIXTURE = join(import.meta.dirname, "fixtures", "metrics", "20261019-100000-aaaaaa", "manifest.json");
const manifest = async () => RunManifest.parse(JSON.parse(await readFile(FIXTURE, "utf8")));

const T0 = Date.parse("2026-10-19T10:00:00.000Z");
let n = 0;
function span(p: Partial<Span> & Pick<Span, "kind">): Span {
  n++;
  return {
    id: `${n}`.padStart(16, "0"),
    runId: "20261019-100000-aaaaaa",
    node: "shot",
    provider: "openrouter-seedance-2.0-fast",
    startedAt: new Date(T0 + n * 1000).toISOString(),
    ms: 500,
    ok: true,
    costUsd: 0,
    request: {},
    response: {},
    ...p,
  };
}

function fakeScores() {
  const created: Parameters<ScoreClient["score"]["create"]>[0][] = [];
  return { created, client: { score: { create: (s: (typeof created)[number]) => void created.push(s) }, shutdown: vi.fn(async () => undefined) } };
}

/** `InMemorySpanExporter.shutdown()` clears what it holds, and the export always shuts down: keep the spans to assert. */
class KeptSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

async function exportSpans(spans: Span[], m: RunManifest) {
  const exporter = new KeptSpanExporter();
  const scores = fakeScores();
  const r = await exportToLangfuse(spans, m, { config, exporter, scores: scores.client });
  return { r, out: exporter.getFinishedSpans(), scores: scores.created };
}

const attr = (s: ReadableSpan, k: string) => s.attributes[k];
const json = (s: ReadableSpan, k: string): unknown => (typeof s.attributes[k] === "string" ? JSON.parse(s.attributes[k]) : undefined);

describe("Langfuse mapping (F17)", () => {
  it("a live generation carries the real model id, token usage and our measured cost; environment is production", async () => {
    const node = span({ kind: "node", node: "writeScript", provider: "graph" });
    const llm = span({
      kind: "llm",
      node: "writeScript",
      parentId: node.id,
      provider: "gemini",
      model: "gemini-3.5-flash",
      costUsd: 0.0123,
      usage: { input: 1000, output: 300, thinking: 50 },
      request: { system: "You write scripts.", prompt: "idea" },
      response: { text: "{}", parsed: true },
    });
    const { r, out } = await exportSpans([llm, node], await manifest());
    expect(r.ok).toBe(true);
    const gen = out.find((s) => attr(s, "langfuse.observation.type") === "generation")!;
    expect(gen.name).toBe("write-script");
    expect(attr(gen, "langfuse.observation.model.name")).toBe("gemini-3.5-flash");
    expect(json(gen, "langfuse.observation.usage_details")).toEqual({ input: 1000, output: 300, thinking: 50 });
    expect(json(gen, "langfuse.observation.cost_details")).toEqual({ total: 0.0123 });
    expect(json(gen, "langfuse.observation.input")).toEqual([
      { role: "system", content: "You write scripts." },
      { role: "user", content: "idea" },
    ]);
    // The node span is listed after its call in trace.jsonl; it is still the parent.
    const parent = out.find((s) => s.name === "write-script" && attr(s, "langfuse.observation.type") === "span")!;
    expect(gen.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    // Real times survive the replay.
    expect(gen.startTime[0]).toBe(Math.floor(Date.parse(llm.startedAt) / 1000));
    for (const s of out) expect(attr(s, "langfuse.environment")).toBe("production");
  });

  it("a failed call is ERROR with our reason as statusMessage; a real-face refusal is WARNING with the rung", async () => {
    const failed = span({ kind: "image", node: "drawKeyframes", provider: "gemini-image", ok: false, error: "gemini-image: HTTP 500 from upstream" });
    const refused = span({
      kind: "video",
      ok: false,
      error: "openrouter-seedance-2.0-fast: rejected by content policy: InputImageSensitiveContentDetected.PrivacyInformation",
      request: { mode: "refs", prompt: "p", seconds: 5 },
    });
    const { out } = await exportSpans([failed, refused], await manifest());
    const img = out.find((s) => s.name === "generate-image")!;
    expect(attr(img, "langfuse.observation.level")).toBe("ERROR");
    expect(attr(img, "langfuse.observation.status_message")).toBe("gemini-image: HTTP 500 from upstream");
    const vid = out.find((s) => s.name === "generate-video")!;
    expect(attr(vid, "langfuse.observation.level")).toBe("WARNING");
    expect(attr(vid, "langfuse.observation.status_message")).toMatch(/^real-face refusal at rung refs: .*PrivacyInformation/);
  });

  it("a failed run makes the root ERROR, with the error in its output", async () => {
    const m = { ...(await manifest()), ok: false, error: "final gate: wer 0.25" };
    const { out } = await exportSpans([span({ kind: "node", node: "finalGate", ok: false, error: "wer 0.25" })], m);
    const root = out.find((s) => s.name === "make-video")!;
    expect(attr(root, "langfuse.observation.type")).toBe("agent");
    expect(attr(root, "langfuse.observation.level")).toBe("ERROR");
    expect(json(root, "langfuse.observation.output")).toMatchObject({ ok: false, error: "final gate: wer 0.25" });
    const gate = out.find((s) => s.name === "final-gate")!;
    expect(attr(gate, "langfuse.observation.type")).toBe("guardrail");
    expect(attr(gate, "langfuse.observation.level")).toBe("ERROR");
  });

  it("a cached step (once hit) is an event with cached: true and no usage or cost", async () => {
    const hit = span({ kind: "video", cached: true, shotId: "s1", request: { prompt: "p", mode: "frame" }, response: { path: "/r/clip-s1.mp4" } });
    const { out } = await exportSpans([hit], await manifest());
    const ev = out.find((s) => s.name === "generate-video")!;
    expect(attr(ev, "langfuse.observation.type")).toBe("event");
    expect(json(ev, "langfuse.observation.metadata.cached")).toBe(true);
    expect(attr(ev, "langfuse.observation.cost_details")).toBeUndefined();
    expect(attr(ev, "langfuse.observation.usage_details")).toBeUndefined();
  });

  it("judges are evaluators; the keyframe score's comment is the judge's issues (shot from the file name)", async () => {
    const m = await manifest();
    m.shots!.s2!.keyframeScore = 6;
    const kf = span({
      kind: "judge",
      node: "drawKeyframes",
      provider: "gemini-judge",
      model: "gemini-3.5-flash",
      costUsd: 0.004,
      request: { rubric: "R".repeat(300), image: { path: "/r/keyframe-s2-abc.png", sha256: "f".repeat(64) }, refs: [] },
      response: { verdict: { score: 6, issues: ["hands malformed", "face too small"] } },
    });
    const { out, scores } = await exportSpans([kf], m);
    const ev = out.find((s) => s.name === "judge-keyframe")!;
    expect(attr(ev, "langfuse.observation.type")).toBe("evaluator");
    expect(json(ev, "langfuse.observation.metadata.model")).toBe("gemini-3.5-flash");
    expect(json(ev, "langfuse.observation.metadata.costUsd")).toBe(0.004);
    expect(json(ev, "langfuse.observation.input")).toEqual([
      { role: "system", content: "R".repeat(300) },
      { role: "user", content: [{ type: "file", path: "/r/keyframe-s2-abc.png", sha256: "f".repeat(64), contentType: "image/png" }] },
    ]);
    expect(scores.find((s) => s.name === "judge_keyframe_s2")).toMatchObject({ value: 6, comment: "hands malformed; face too small" });
    expect(scores.find((s) => s.name === "judge_clip_s2")).toMatchObject({ value: 8 });
    expect(scores.find((s) => s.name === "verbatim_pass")).toMatchObject({ value: 1, dataType: "BOOLEAN" });
    expect(scores.find((s) => s.name === "cost_usd")).toMatchObject({ value: 0.5 });
  });

  it("tags come from the run and script; session = run id; a failed export is a redacted result, never a throw", async () => {
    const m = await manifest();
    expect(tagsOf(m)).toEqual(["mode:live", "storyboard", "wide"]);
    const two = { ...m, subtitles: { file: "/r/final.mp4", cues: [{ start: 0, end: 1, text: "hi" }] } };
    two.script = { ...m.script!, characters: [...m.script!.characters, { ...m.script!.characters[0]!, name: "Son" }] };
    expect(tagsOf(two)).toEqual(["mode:live", "storyboard", "dialogue", "wide", "subtitles"]);
    expect(planTrace([], m)).toMatchObject({ traceName: "make-video", sessionId: m.runId, environment: "production" });
    expect(planScores({ ...m, verbatim: undefined, shots: undefined }, []).map((s) => s.name)).toEqual(["cost_usd"]);

    const broken = { export: () => { throw new Error(`boom ${config.secretKey}`); }, shutdown: async () => undefined, forceFlush: async () => undefined };
    const r = await exportToLangfuse([span({ kind: "image" })], m, { config, exporter: broken, scores: fakeScores().client });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(config.secretKey);
  });

  // The real ScoreManager swallows HTTP errors and partial rejections (it only logs them through the Langfuse global
  // logger), so these use the real LangfuseClient with `fetch` stubbed: no network, but the SDK's own failure path.
  describe("a failed score upload is a redacted note, not a silent drop", () => {
    async function exportWithScoresApi(respond: (url: string) => Response) {
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return respond(url);
      });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const { LangfuseClient } = await import("@langfuse/client");
        const client = new LangfuseClient({ publicKey: config.publicKey, secretKey: config.secretKey, baseUrl: "http://langfuse.invalid" });
        const r = await exportToLangfuse([span({ kind: "image" })], await manifest(), { config, exporter: new KeptSpanExporter(), scores: client });
        return { r, urls };
      } finally {
        quiet.mockRestore();
        vi.unstubAllGlobals();
      }
    }

    it("HTTP 401 from the scores endpoint → ok:false, keys redacted", async () => {
      const { r, urls } = await exportWithScoresApi(() => new Response(JSON.stringify({ message: `bad key ${config.secretKey}` }), { status: 401 }));
      expect(urls.some((u) => u.includes("/api/public/scores"))).toBe(true);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/score/i);
      expect(JSON.stringify(r)).not.toContain(config.secretKey);
    });

    it("a partially rejected batch (HTTP 207) → ok:false naming the rejection", async () => {
      const { r } = await exportWithScoresApi(() =>
        new Response(JSON.stringify({ accepted: 1, rejected: 1, errors: [{ index: 0, message: "invalid value" }], results: [] }), { status: 207 }),
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/rejected 1/);
    });

    it("an accepted batch → ok:true", async () => {
      const { r } = await exportWithScoresApi(() => new Response(JSON.stringify({ accepted: 4, rejected: 0, errors: [], results: [] }), { status: 200 }));
      expect(r).toMatchObject({ ok: true });
    });
  });
});
