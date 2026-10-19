import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as compareMain } from "../evals/compare.ts";
import {
  aggregate,
  compare,
  EvalResults,
  failedIdea,
  parseIdeas,
  percentile,
  summarize,
  withAggregates,
  type EvalIdea,
  type IdeaResult,
} from "../evals/metrics.ts";
import { main as runMain, parseEvalArgs, resultsPath, selectIdeas } from "../evals/run.ts";
import { defaultBlocking, type Attempt, type RunManifest } from "../src/schemas.ts";
import { extractQuotedLines } from "../src/verbatim.ts";

const words = (s: string) => s.split(/\s+/).filter(Boolean);

const spec: EvalIdea = { id: "x", idea: 'He says: "Hello there."', tags: ["quoted"] };
const pass = { expected: "hello there", heard: "hello there", wer: 0, ops: [], pass: true };
const fail = { expected: "hello there", heard: "hello", wer: 0.5, ops: [{ type: "del" as const, expected: "there" }], pass: false };

const att = (stage: string, ok = true, extra: Partial<Attempt> = {}): Attempt => ({ stage, n: 1, provider: "p", ok, costUsd: 0.1, ms: 100, ...extra });

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "r1",
    idea: spec.idea,
    mode: "mock",
    createdAt: "2026-10-16T00:00:00.000Z",
    script: {
      promptVersion: "v",
      title: "t",
      logline: "l",
      setting: "s",
      characters: [{ name: "A", look: "x", voice: { gender: "female", age: "adult", tone: "calm" }, voiceDescription: "calm female voice" }],
      shots: [
        { id: "s1", camera: "close-up", visual: "v", motion: "m", emotion: "e", line: "", seconds: 4, onScreen: ["A"], blocking: defaultBlocking(["A"], null), continuity: { from: "start", screenDirection: "neutral" } },
        { id: "s2", camera: "close-up", visual: "v", motion: "m", emotion: "e", line: "Hello there.", seconds: 6, speaker: "A", onScreen: ["A"], blocking: defaultBlocking(["A"], "A"), continuity: { from: "right after s1", screenDirection: "neutral" } },
      ],
      quotedLines: ["Hello there."],
    },
    shots: {
      s1: { path: "a", seconds: 4, hasAudio: false, audio: "silent", keyframeScore: 8 },
      s2: { path: "b", seconds: 6, hasAudio: true, audio: "native", verbatim: pass },
    },
    attempts: [att("script"), att("judge", true, { score: 8 }), att("video"), att("video"), att("judge", true, { score: 6 }), att("final")],
    costUsd: 0.6,
    final: { path: "f.mp4", seconds: 10, width: 1080, height: 1920, hasAudio: true },
    verbatim: pass,
    ok: true,
    ...over,
  };
}

const row = (over: Partial<IdeaResult> = {}): IdeaResult => ({ ...summarize(spec, manifest(), { manifest: "m.json", wallMs: 1000 }), ...over });

describe("summarize", () => {
  it("clean native run: first try and final both pass, stage counts and judge scores collected", () => {
    const r = summarize(spec, manifest(), { manifest: "m.json", wallMs: 1234.6 });
    expect(r).toMatchObject({ ok: true, verbatimFirstTry: true, verbatimFinal: true, wer: 0, seconds: 10, costUsd: 0.6, wallMs: 1235, human: null });
    expect(r.attemptsByStage).toEqual({ script: 1, judge: 2, video: 2, final: 1 });
    expect(r.msByStage.video).toBe(200);
    expect(r.judgeScores).toEqual([8, 6]);
  });

  it("a failed native take then a pass is final-pass but not first-try", () => {
    const m = manifest({ attempts: [att("script"), att("video", false, { reason: "del there" }), att("video", true, { n: 2 }), att("final")] });
    expect(summarize(spec, m, { manifest: "", wallMs: 0 })).toMatchObject({ verbatimFirstTry: false, verbatimFinal: true });
  });

  it("TTS + lip-sync fallback is not first-try", () => {
    const m = manifest({
      attempts: [att("fallback"), att("voice"), att("lipsync"), att("final")],
      shots: { s2: { path: "b", seconds: 6, hasAudio: true, audio: "fallback", verbatim: pass } },
    });
    expect(summarize(spec, m, { manifest: "", wallMs: 0 }).verbatimFirstTry).toBe(false);
  });

  it("final mishearing fails both, and a run without a script has no first try", () => {
    const misheard = summarize(spec, manifest({ verbatim: fail, ok: false, error: "final gate" }), { manifest: "", wallMs: 0 });
    expect(misheard).toMatchObject({ ok: false, verbatimFirstTry: false, verbatimFinal: false, wer: 0.5, error: "final gate" });
    const { script: _s, shots: _sh, final: _f, verbatim: _v, ...bare } = manifest({ ok: false });
    expect(summarize(spec, bare, { manifest: "", wallMs: 0 })).toMatchObject({ verbatimFirstTry: false, verbatimFinal: false, seconds: null });
  });

  it("needsReview on any shot is surfaced", () => {
    const m = manifest();
    m.shots!.s1!.needsReview = true;
    expect(summarize(spec, m, { manifest: "", wallMs: 0 }).needsReview).toBe(true);
  });
});

describe("percentile", () => {
  it("nearest rank, empty → 0", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });
});

describe("aggregate", () => {
  it("rates, means per stage (missing stage = 0), judge mean/min, cost per video and per success", () => {
    const a = row({ wallMs: 1000 });
    const b = row({ verbatimFirstTry: false, attemptsByStage: { script: 1, video: 4 }, msByStage: { video: 900 }, judgeScores: [3], wallMs: 3000, costUsd: 1.2 });
    const c = { ...failedIdea(spec, "boom", 500), costUsd: 0.3 };
    const g = aggregate([a, b, c]);
    expect(g.n).toBe(3);
    expect(g.successRate).toBeCloseTo(2 / 3, 4);
    expect(g.verbatimFirstTryRate).toBeCloseTo(1 / 3, 4);
    expect(g.verbatimFinalRate).toBeCloseTo(2 / 3, 4);
    expect(g.meanAttemptsPerStage.video).toBeCloseTo((2 + 4 + 0) / 3, 3);
    expect(g.meanAttemptsPerStage.judge).toBeCloseTo(2 / 3, 3); // only `a` has judge attempts
    expect(g.judge).toEqual({ mean: 5.667, min: 3, n: 3 });
    expect(g.costPerVideoUsd).toBeCloseTo((0.6 + 1.2 + 0.3) / 3, 6);
    expect(g.costPerSuccessUsd).toBeCloseTo((0.6 + 1.2 + 0.3) / 2, 6);
    expect(g.meanSeconds).toBe(10);
    expect(g.stageMs.video).toEqual({ p50: 200, p90: 900 });
    expect(g.wallMs).toEqual({ p50: 1000, p90: 3000, total: 4500 });
    expect(g.human).toBeNull();
  });

  it("empty set and no successes don't divide by zero; human ratings are averaged when filled in", () => {
    expect(aggregate([])).toMatchObject({ n: 0, successRate: 0, costPerVideoUsd: 0, costPerSuccessUsd: null, judge: null, meanSeconds: null });
    expect(aggregate([failedIdea(spec, "x", 1)]).costPerSuccessUsd).toBeNull();
    expect(aggregate([row({ human: 4 }), row({ human: 1 }), row()]).human).toEqual({ mean: 2.5, n: 2 });
  });
});

function results(ideas: IdeaResult[], label = "a"): EvalResults {
  return withAggregates({ version: 1, label, mode: "mock", createdAt: "2026-10-16T00:00:00.000Z", ideas });
}

describe("compare", () => {
  const base = results([row(), row(), row()]);
  const flagged = (a: EvalResults, b: EvalResults) => compare(a, b).filter((r) => r.regression).map((r) => r.metric);

  it("identical runs: deltas 0, nothing flagged", () => {
    expect(flagged(base, base)).toEqual([]);
    expect(compare(base, base).find((r) => r.metric === "verbatimFinalRate")).toMatchObject({ a: 1, b: 1, delta: 0 });
  });

  it("injected regression: one idea fails the verbatim gate → flagged", () => {
    const worse = results([row(), row(), row({ ok: false, verbatimFinal: false, verbatimFirstTry: false })], "b");
    const rows = compare(base, worse);
    expect(rows.find((r) => r.metric === "verbatimFinalRate")).toMatchObject({ regression: true, delta: -0.3333 });
    expect(flagged(base, worse)).toEqual(["successRate", "verbatimFirstTryRate", "verbatimFinalRate"]);
  });

  it("cost: +20% is tolerated, +21% is flagged; from $0 any spend is flagged", () => {
    const at = (usd: number) => results([row({ costUsd: usd })]);
    expect(flagged(at(1), at(1.2))).toEqual([]);
    expect(flagged(at(1), at(1.21))).toEqual(["costPerVideoUsd"]);
    expect(flagged(at(0), at(0.01))).toEqual(["costPerVideoUsd"]);
    expect(flagged(at(1), at(0.5))).toEqual([]);
  });

  it("judge mean: down 0.5 is tolerated, down more is flagged", () => {
    const at = (scores: number[]) => results([row({ judgeScores: scores })]);
    expect(flagged(at([8]), at([7.5]))).toEqual([]);
    expect(flagged(at([8]), at([7]))).toEqual(["judge.mean"]);
  });

  it("CLI exits 1 on a regression and 0 without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-cmp-"));
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await writeFile(a, JSON.stringify(base));
    await writeFile(b, JSON.stringify(results([row(), row(), row({ costUsd: 5 })], "b")));
    const lines: string[] = [];
    expect(await compareMain([a, b], (l) => lines.push(l), () => {})).toBe(1);
    expect(lines.join("\n")).toMatch(/REGRESSION: cost per video up more than 20%/);
    expect(await compareMain([a, a], () => {}, () => {})).toBe(0);
    expect(await compareMain([a], () => {}, () => {})).toBe(2);
  });

  it("CLI uses hand-filled human ratings even though the stored aggregates predate them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-cmp-"));
    const a = join(dir, "a.json");
    const rated = { ...base, ideas: base.ideas.map((i) => ({ ...i, human: 4 })) }; // aggregates.human still null
    await writeFile(a, JSON.stringify(rated));
    const lines: string[] = [];
    await compareMain([a, a], (l) => lines.push(l), () => {});
    expect(lines.join("\n")).toMatch(/human\.mean\s+4\s+4\s+0/);
  });
});

describe("ideas.jsonl", () => {
  it("10 ideas, ≥6 quoted, covering every required case; the rest quote nothing", async () => {
    const ideas = parseIdeas(await readFile(new URL("../evals/ideas.jsonl", import.meta.url), "utf8"));
    expect(ideas).toHaveLength(10);
    const quoted = ideas.filter((i) => extractQuotedLines(i.idea).length > 0);
    expect(quoted.length).toBeGreaterThanOrEqual(6);
    for (const i of ideas) expect(i.tags.includes("quoted")).toBe(extractQuotedLines(i.idea).length > 0);
    const tags = new Set(quoted.flatMap((i) => i.tags));
    for (const t of ["contractions", "number", "name", "question", "exclamation", "curly-quotes", "em-dash", "long-line"]) expect(tags).toContain(t);
    // The tags must be true of the line itself, not just labels.
    const line = (tag: string) => extractQuotedLines(quoted.find((i) => i.tags.includes(tag))!.idea)[0]!;
    expect(line("contractions")).toMatch(/\w'\w/);
    expect(line("number")).toMatch(/\b3 a\.m\./);
    expect(line("question")).toMatch(/\?$/);
    expect(line("exclamation")).toMatch(/!$/);
    expect(line("em-dash")).toContain("—");
    expect(quoted.find((i) => i.tags.includes("curly-quotes"))!.idea).toMatch(/“[^”]+”/);
    expect(words(line("long-line")).length).toBeGreaterThanOrEqual(14);
    expect(words(line("long-line")).length).toBeLessThanOrEqual(18);
  });

  it("parseIdeas names the bad line and rejects duplicate ids", () => {
    expect(() => parseIdeas('{"id":"a","idea":"x","tags":[]}\n{"id":"a","idea":"y","tags":[]}')).toThrow(/line 2: duplicate id a/);
    expect(() => parseIdeas('{"id":"A B","idea":"x","tags":[]}')).toThrow(/line 1/);
  });
});

describe("run.ts", () => {
  it("parses flags; mode is required; label is slugged", () => {
    expect(parseEvalArgs(["--mock", "--limit", "3", "--ids", "a,b", "--label", "New Prompt!"])).toEqual({ mode: "mock", limit: 3, ids: ["a", "b"], label: "new-prompt" });
    expect(parseEvalArgs(["--live"])).toEqual({ mode: "live", label: "run" });
    expect(() => parseEvalArgs([])).toThrow(/--mock or --live/);
    expect(() => parseEvalArgs(["--mock", "--live"])).toThrow(/exclusive/);
    expect(() => parseEvalArgs(["--mock", "--limit", "0"])).toThrow(/positive/);
    expect(() => parseEvalArgs(["--mock", "--label"])).toThrow(/needs a value/);
  });

  it("F10: --set picks evals/<set>.jsonl; only plain set names", () => {
    expect(parseEvalArgs(["--mock", "--set", "hard"])).toEqual({ mode: "mock", label: "run", set: "hard" });
    expect(() => parseEvalArgs(["--mock", "--set", "../x"])).toThrow(/set name/);
    expect(() => parseEvalArgs(["--mock", "--set"])).toThrow(/needs a value/);
  });

  it("F10: hard.jsonl parses; a mock run records Ukrainian as a clean rejection and three lines as ok", { timeout: 120_000 }, async () => {
    const hard = parseIdeas(await readFile(new URL("../evals/hard.jsonl", import.meta.url), "utf8"));
    expect(hard.length).toBeGreaterThanOrEqual(19);
    const dir = await mkdtemp(join(tmpdir(), "evals-hard-"));
    const code = await runMain(["--mock", "--set", "hard", "--ids", "ukrainian-only,nested-double-quotes,three-lines", "--label", "t"], {
      env: {},
      resultsDir: join(dir, "results"),
      runsDir: join(dir, "runs"),
      now: () => new Date("2026-10-19T12:00:00Z"),
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    const r = EvalResults.parse(JSON.parse(await readFile(join(dir, "results", "2026-10-19-t-mock.json"), "utf8")));
    const byId = Object.fromEntries(r.ideas.map((i) => [i.id, i]));
    for (const id of ["ukrainian-only", "nested-double-quotes"]) {
      expect(byId[id]).toMatchObject({ ok: false, rejected: true, costUsd: 0 });
      expect(byId[id]!.runId).not.toBeNull(); // went through the pipeline and has a manifest: not a crash
    }
    expect(byId["ukrainian-only"]!.error).toMatch(/only English lines are supported/);
    expect(byId["three-lines"]).toMatchObject({ ok: true, verbatimFinal: true });
    expect(byId["three-lines"]!.rejected).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("selects by id then limit; unknown ids are an error", () => {
    const all = ["a", "b", "c"].map((id) => ({ id, idea: id, tags: [] }));
    expect(selectIdeas(all, { ids: ["c", "a"], limit: 1 }).map((i) => i.id)).toEqual(["a"]);
    expect(selectIdeas(all, { limit: 2 }).map((i) => i.id)).toEqual(["a", "b"]);
    expect(() => selectIdeas(all, { ids: ["z"] })).toThrow(/unknown idea id/);
  });

  it("results path is <date>-<label>-<mode>.json and never overwrites", () => {
    const d = new Date("2026-10-16T12:00:00Z");
    expect(resultsPath("/r", d, "base", "mock", () => false)).toBe("/r/2026-10-16-base-mock.json");
    const taken = new Set(["/r/2026-10-16-base-mock.json", "/r/2026-10-16-base-mock-2.json"]);
    expect(resultsPath("/r", d, "base", "mock", (p) => taken.has(p))).toBe("/r/2026-10-16-base-mock-3.json");
  });

  it("mock run of one idea writes a valid results file with aggregates", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "evals-run-"));
    const out: string[] = [];
    const code = await runMain(["--mock", "--ids", "widow-curly-emdash", "--label", "t"], {
      env: {},
      resultsDir: join(dir, "results"),
      runsDir: join(dir, "runs"),
      now: () => new Date("2026-10-16T12:00:00Z"),
      stdout: (l) => out.push(l),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(await readdir(join(dir, "results"))).toEqual(["2026-10-16-t-mock.json"]);
    const r = EvalResults.parse(JSON.parse(await readFile(join(dir, "results", "2026-10-16-t-mock.json"), "utf8")));
    expect(r.ideas.map((i) => i.id)).toEqual(["widow-curly-emdash"]);
    expect(r.aggregates).toMatchObject({ n: 1, successRate: 1, verbatimFirstTryRate: 1, verbatimFinalRate: 1, costPerVideoUsd: 0 });
    expect(r.aggregates.judge?.min).toBeGreaterThanOrEqual(1);
    expect(Object.keys(r.aggregates.stageMs)).toContain("video");
    expect(out.join("\n")).toMatch(/verbatim pass \(final\)/);
  });
});
