import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { extractFrames, frameArgs, frameTimes } from "../src/media/frames.ts";
import { probe } from "../src/media/ffmpeg.ts";
import {
  judge,
  judgedKeyframe,
  judgedTalkingShot,
  pickBest,
  qualityFromEnv,
  regenEstimateUsd,
} from "../src/nodes/quality.ts";
import { castCharacter, talkingShot } from "../src/nodes/visuals.ts";
import { clipRubric, JUDGE_PROMPT_VERSION, keyframeRubric, withIssues } from "../src/prompts/judge.ts";
import type { GenAiClient } from "../src/providers/gemini.ts";
import {
  Budget,
  GeminiJudge,
  JudgeOutputError,
  MockAsr,
  MockImage,
  MockJudge,
  MockLipsync,
  MockTts,
  MockVideo,
  withBudget,
  createProviders,
  type AnimateRequest,
} from "../src/providers/index.ts";
import { JudgeVerdict, RunManifest, Script } from "../src/schemas.ts";

const LINE = "I kept the watch. I kept everything.";
const SCRIPT = Script.parse({
  promptVersion: "test",
  title: "The watch",
  logline: "A man tells his brother he kept everything.",
  setting: "a rooftop at dusk",
  character: {
    name: "Dan",
    look: "a man in his forties, short grey beard, navy wool coat",
    voice: { gender: "male", age: "adult", tone: "low, tired" },
  },
  shots: [
    {
      id: "s1",
      camera: "medium close-up",
      visual: "Dan holds a phone to his ear, an old watch in his other hand",
      motion: "he lifts the watch into view",
      emotion: "quiet, hurt",
      line: LINE,
      seconds: 6.2,
    },
    { id: "s2", camera: "close-up", visual: "Dan's face, eyes wet", motion: "he lowers the phone", emotion: "resigned", line: "", seconds: 4 },
  ],
  quotedLines: [LINE],
});
const S1 = SCRIPT.shots[0]!;
const SLOW = 90_000;
const ISSUE = "six fingers on the left hand";

let root: string;
let n = 0;
const fresh = () => join(root, `run-${++n}`);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "itv-judge-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const judgeAttempts = (as: { stage: string; score?: number; ok: boolean; reason?: string }[]) => as.filter((a) => a.stage === "judge");

describe("contracts and pure parts", () => {
  it("JudgeVerdict: integer score 1–10 and an issues array, nothing else passes", () => {
    expect(JudgeVerdict.safeParse({ score: 7, issues: [] }).success).toBe(true);
    for (const bad of [{ score: 0, issues: [] }, { score: 11, issues: [] }, { score: 7.5, issues: [] }, { score: 7 }, { score: "8", issues: [] }, null]) {
      expect(JudgeVerdict.safeParse(bad).success).toBe(false);
    }
  });

  it("frameTimes: centres of N equal slices; frameArgs: one frame, fast seek", () => {
    expect(frameTimes(9, 3)).toEqual([1.5, 4.5, 7.5]);
    expect(frameTimes(5, 1)).toEqual([2.5]);
    expect(frameTimes(10, 3)).toEqual([1.667, 5, 8.333]);
    expect(() => frameTimes(0, 3)).toThrow(RangeError);
    expect(() => frameTimes(5, 0)).toThrow(RangeError);
    expect(frameArgs({ input: "in.mp4", at: 1.6667, out: "f.jpg" })).toEqual(["-ss", "1.667", "-i", "in.mp4", "-frames:v", "1", "-q:v", "3", "f.jpg"]);
    expect(() => frameArgs({ input: "a", at: -1, out: "b" })).toThrow(RangeError);
  });

  it("rubrics name what a VLM can see, from the shot and the character; withIssues appends", () => {
    const k = keyframeRubric(S1, SCRIPT);
    expect(k).toContain(S1.visual);
    expect(k).toContain(SCRIPT.characters[0]!.look);
    expect(k).toMatch(/hands/i);
    expect(k).toMatch(/lip-sync/i);
    expect(k).toMatch(/watermark/i);
    expect(k).toMatch(/vertical/i);
    const c = clipRubric(S1, SCRIPT);
    expect(c).toMatch(/reference portrait/);
    expect(c).toMatch(/warping or morphing/);
    expect(c).toMatch(/mouth/i);
    expect(c).toContain(S1.motion);
    expect(JUDGE_PROMPT_VERSION).toMatch(/^judge-v\d+$/);
    expect(withIssues("Draw it.", [])).toBe("Draw it.");
    expect(withIssues("Draw it.", ["a  b", "c"])).toBe("Draw it. Avoid these problems from the previous attempt: a b; c.");
  });

  it("pickBest: first pass, else highest score (earliest on ties), else the first", () => {
    expect(pickBest([{ pass: false, score: 3 }, { pass: true, score: 8 }, { pass: true, score: 9 }])).toBe(1);
    expect(pickBest([{ pass: false, score: 3 }, { pass: false, score: 5 }, { pass: false, score: 5 }])).toBe(1);
    expect(pickBest([{ pass: false }, { pass: false, score: 2 }])).toBe(1);
    expect(pickBest([{ pass: false }, { pass: false }])).toBe(0);
  });

  it("qualityFromEnv: defaults 7 / 5, overrides, garbage fails loudly", () => {
    expect(qualityFromEnv({})).toEqual({ keyframeMin: 7, clipMin: 5 });
    expect(qualityFromEnv({ KEYFRAME_MIN: "8", CLIP_MIN: "6" })).toEqual({ keyframeMin: 8, clipMin: 6 });
    expect(() => qualityFromEnv({ CLIP_MIN: "eleven" })).toThrow(/CLIP_MIN/);
    expect(() => qualityFromEnv({ KEYFRAME_MIN: "0" })).toThrow(/KEYFRAME_MIN/);
  });

  it("Budget.allows: same arithmetic as the guard, without calling anything", () => {
    const b = new Budget(1, 0.6);
    expect(b.allows(0.4)).toBe(true);
    expect(b.allows(0.41)).toBe(false);
    expect(b.allows(0)).toBe(true);
  });
});

describe("judge providers", () => {
  it("MockJudge: scripted scores, then the fallback; a bad shape throws JudgeOutputError", async () => {
    const img = (await new MockImage().generate({ prompt: "x", out: join(root, `img-${++n}.png`) })).path;
    const j = new MockJudge({ image: [4, { score: 6, issues: [ISSUE] }, { raw: { score: 11, issues: [] } }] });
    expect((await j.judgeImage({ path: img, rubric: "r" })).score).toBe(4);
    expect(await j.judgeImage({ path: img, rubric: "r" })).toEqual({ score: 6, issues: [ISSUE], costUsd: 0 });
    await expect(j.judgeImage({ path: img, rubric: "r" })).rejects.toBeInstanceOf(JudgeOutputError);
    expect((await j.judgeImage({ path: img, rubric: "r" })).score).toBe(8);
    expect(j.calls).toHaveLength(4);
  });

  it("GeminiJudge: inline images, structured output, model chain, cost; bad JSON → JudgeOutputError with cost", async () => {
    const img = (await new MockImage().generate({ prompt: "y", out: join(root, `img-g-${++n}.png`) })).path;
    const seen: unknown[] = [];
    const replies: (() => unknown)[] = [
      () => {
        throw Object.assign(new Error("busy"), { status: 429 });
      },
      () => ({ text: JSON.stringify({ score: 6, issues: [ISSUE] }), usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } }),
      () => ({ text: "not json", usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 0 } }),
    ];
    const client: GenAiClient = {
      models: {
        generateContent: async (params) => {
          seen.push(params);
          return replies.shift()!() as never;
        },
      },
    };
    const j = GeminiJudge.fromEnv({ GEMINI_API_KEY: "test", JUDGE_MODELS: "gemini-3.8-flash,gemini-2.5-flash" }, client);
    const r = await j.judgeVideo({ frames: [img, img], rubric: "RUBRIC", refs: [img] });
    expect(r.score).toBe(6);
    expect(r.issues).toEqual([ISSUE]);
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.notes?.[0]).toMatch(/gemini-3\.8-flash unavailable \(429\)/);
    expect(r.costUsd).toBeCloseTo((1000 * 0.3 + 100 * 2.5) / 1e6, 10);
    const req = seen[1] as { model: string; contents: { parts: Record<string, unknown>[] }[]; config: Record<string, unknown> };
    expect(req.model).toBe("gemini-2.5-flash");
    const parts = req.contents[0]!.parts;
    expect(parts[0]).toEqual({ text: "RUBRIC" });
    expect(parts.filter((p) => "inlineData" in p)).toHaveLength(3);
    expect((parts.find((p) => "inlineData" in p)!.inlineData as { mimeType: string }).mimeType).toBe("image/png");
    expect(req.config.responseMimeType).toBe("application/json");
    expect(JSON.stringify(req.config.responseJsonSchema)).toContain("issues");
    const bad = await j.judgeImage({ path: img, rubric: "R" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(JudgeOutputError);
    expect((bad as JudgeOutputError).costUsd).toBeGreaterThan(0);
    expect(j.estimateUsd({ images: 4, rubric: "R" })).toBeGreaterThan(j.estimateUsd({ images: 1, rubric: "R" }));
    expect(() => GeminiJudge.fromEnv({})).toThrow(/GEMINI_API_KEY/);
  });

  it("withBudget books the cost of a paid-but-invalid judge reply", async () => {
    const budget = new Budget(1);
    const paidBad = {
      name: "paid-bad",
      judgeImage: async () => {
        throw new JudgeOutputError("paid-bad", "score: too big", { score: 11 }, 0.01);
      },
      judgeVideo: async () => ({ score: 8, issues: [], costUsd: 0.02 }),
      estimateUsd: () => 0.05,
    };
    const p = withBudget({ ...createProviders({ mode: "mock", env: {} }), judge: paidBad }, budget);
    await expect(p.judge.judgeImage({ path: "x", rubric: "r" })).rejects.toBeInstanceOf(JudgeOutputError);
    await p.judge.judgeVideo({ frames: [], rubric: "r" });
    expect(budget.spentUsd).toBeCloseTo(0.03, 10);
  });
});

async function portraitIn(dir: string, image = new MockImage()) {
  return (await castCharacter(SCRIPT, { image, dir })).path;
}

describe("keyframes (acceptance 1, 2, 4)", () => {
  it("1. scripted judge 4 → 8: regenerated once, issues in the second prompt, both scores recorded", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await portraitIn(dir, image);
    const j = new MockJudge({ image: [{ score: 4, issues: [ISSUE] }, 8] });
    const r = await judgedKeyframe(S1, SCRIPT, portrait, undefined, { image, judge: j, dir });
    const kfCalls = image.calls.slice(1);
    expect(kfCalls).toHaveLength(2);
    expect(kfCalls[0]!.prompt).not.toContain(ISSUE);
    expect(kfCalls[1]!.prompt).toContain(ISSUE);
    expect(kfCalls[1]!.variant).toBe(1);
    const judged = judgeAttempts(r.attempts);
    expect(judged.map((a) => a.score)).toEqual([4, 8]);
    expect(judged.map((a) => a.ok)).toEqual([false, true]);
    expect(judged[0]!.reason).toContain(ISSUE);
    expect(r.score).toBe(8);
    expect(r.needsReview).toBe(false);
    expect(r.path).not.toBe(kfCalls[0]!.out);
    expect(j.calls.every((c) => c.kind === "image" && c.refs?.[0] === portrait)).toBe(true);
    expect(j.calls[0]!.rubric).toBe(keyframeRubric(S1, SCRIPT));
  });

  it("2. always-low judge: at most 2 extra keyframes, the best kept, needsReview", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await portraitIn(dir, image);
    const j = new MockJudge({ image: [3, 5, 4], fallback: 2 });
    const r = await judgedKeyframe(S1, SCRIPT, portrait, undefined, { image, judge: j, dir });
    expect(image.calls.slice(1)).toHaveLength(3);
    expect(j.calls).toHaveLength(3);
    const judged = judgeAttempts(r.attempts);
    expect(judged.filter((a) => a.score !== undefined && a.reason?.startsWith("keyframe score")).map((a) => a.score)).toEqual([3, 5, 4]);
    expect(r.score).toBe(5);
    expect(r.needsReview).toBe(true);
    const keyframeAttempts = r.attempts.filter((a) => a.stage === "keyframe");
    expect(keyframeAttempts.map((a) => a.n)).toEqual([1, 2, 3]);
    expect((await stat(r.path)).isFile()).toBe(true);
    expect(r.attempts.at(-1)!.reason).toMatch(/kept the best \(score 5\); needs review/);
  });

  it("2b. the kept keyframe is literally the best-scoring take's file", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await portraitIn(dir, image);
    const j = new MockJudge({ image: [3, 5, 4] });
    const r = await judgedKeyframe(S1, SCRIPT, portrait, undefined, { image, judge: j, dir, maxExtra: 2 });
    const judged = j.calls.map((c) => (c.kind === "image" ? c.path : ""));
    expect(r.path).toBe(judged[1]);
    expect(new Set(judged).size).toBe(3);
  });

  it("4. judge output failing the schema is a recorded judge failure, never a pass", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await portraitIn(dir, image);
    const j = new MockJudge({ image: [{ raw: { score: 11, issues: [] } }, { raw: { verdict: "great" } }, { raw: "10/10" }] });
    const r = await judgedKeyframe(S1, SCRIPT, portrait, undefined, { image, judge: j, dir });
    expect(image.calls.slice(1)).toHaveLength(3); // each failure triggered a redraw, like a low score
    const judged = judgeAttempts(r.attempts);
    expect(judged.slice(0, 3).every((a) => !a.ok && a.score === undefined && /judge output invalid/.test(a.reason ?? ""))).toBe(true);
    expect(r.score).toBeUndefined();
    expect(r.needsReview).toBe(true);
    expect(r.attempts.at(-1)!.reason).toMatch(/none scored/);
  });

  it("verdicts are cached by judged file: judging the same keyframe again calls no judge", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await portraitIn(dir, image);
    const j = new MockJudge();
    const a = await judge("keyframe", { paths: [portrait], refs: [] }, { judge: j, rubric: "r", min: 7, dir, shotId: "s1", n: 1 });
    const b = await judge("keyframe", { paths: [portrait], refs: [] }, { judge: j, rubric: "r", min: 7, dir, shotId: "s1", n: 1 });
    expect(j.calls).toHaveLength(1);
    expect(b.verdict).toEqual(a.verdict);
    expect(b.attempt.reason).toMatch(/reused cached verdict/);
    // A failed judge call is not cached: the next call asks again.
    const bad = new MockJudge({ image: [{ raw: {} }] });
    const c = await judge("keyframe", { paths: [portrait], refs: [] }, { judge: bad, rubric: "other", min: 7, dir, shotId: "s1", n: 1 });
    const d = await judge("keyframe", { paths: [portrait], refs: [] }, { judge: bad, rubric: "other", min: 7, dir, shotId: "s1", n: 1 });
    expect(c.pass).toBe(false);
    expect(d.pass).toBe(true);
    expect(bad.calls).toHaveLength(2);
  });
});

/** MockVideo with a price, so the budget guard has something to say no to. */
class PricedVideo extends MockVideo {
  estimateUsd(req: AnimateRequest): number {
    return 0.1 * req.seconds;
  }
}

function shotRig(dir: string, judgeOpts: ConstructorParameters<typeof MockJudge>[0], video = new MockVideo()) {
  return {
    script: SCRIPT,
    video,
    asr: new MockAsr(),
    tts: new MockTts(),
    lipsync: new MockLipsync(),
    judge: new MockJudge(judgeOpts),
    dir,
  };
}

describe("clips (acceptance 3, 4)", () => {
  it(
    "frames: extractFrames samples 3 frames from a real clip, content-addressed",
    async () => {
      const dir = fresh();
      const kf = await portraitIn(dir);
      const clip = await talkingShot(S1, kf, { ...shotRig(dir, {}), maxNative: 1 });
      const frames = await extractFrames(clip.path, 3, dir);
      expect(frames).toHaveLength(3);
      for (const f of frames) expect((await probe(f)).width).toBeGreaterThan(0);
      expect(await extractFrames(clip.path, 3, dir)).toEqual(frames);
    },
    SLOW,
  );

  it(
    "3. low clip score + budget guard says no: no regeneration, recorded, take 1 kept with needsReview",
    async () => {
      const dir = fresh();
      const portrait = await portraitIn(dir);
      const video = new PricedVideo();
      const rig = shotRig(dir, { video: [{ score: 2, issues: ["face melts in frame 2"] }] }, video);
      const budget = new Budget(1, 0.9); // 0.10 left; a regeneration needs ≥ 2 × 0.7
      const r = await judgedTalkingShot(S1, portrait, { ...rig, portrait, budget });
      expect(video.calls).toHaveLength(1);
      expect(rig.judge.calls.filter((c) => c.kind === "video")).toHaveLength(1);
      const call = rig.judge.calls[0]!;
      expect(call.kind === "video" && call.frames).toHaveLength(3);
      expect(call.refs).toEqual([portrait]);
      const skipped = r.attempts.find((a) => a.stage === "regen");
      expect(skipped).toMatchObject({ ok: false, provider: "budget" });
      expect(skipped!.reason).toMatch(/clip score 2 < 5; regeneration skipped: budget guard/);
      expect(r.clipScore).toBe(2);
      expect(r.needsReview).toBe(true);
      expect(r.via).toBe("native");
      expect(judgeAttempts(r.attempts).map((a) => a.score)).toEqual([2]);
      expect(regenEstimateUsd(S1, portrait, { ...rig, portrait })).toBeCloseTo(2 * 0.7, 6);
    },
    SLOW,
  );

  it(
    "3b. low clip score + budget allows: one regeneration with the issues in the prompt; the better take wins",
    async () => {
      const dir = fresh();
      const portrait = await portraitIn(dir);
      const video = new PricedVideo();
      const rig = shotRig(dir, { video: [{ score: 2, issues: ["face melts in frame 2"] }, 7] }, video);
      const r = await judgedTalkingShot(S1, portrait, { ...rig, portrait, budget: new Budget(10) });
      expect(video.calls).toHaveLength(2);
      expect(video.calls[0]!.prompt).not.toContain("face melts");
      expect(video.calls[1]!.prompt).toContain("face melts in frame 2");
      expect(video.calls[1]!.prompt).toContain(`says in English: {${LINE}}`); // the line is still quoted exactly
      expect(video.calls[1]!.variant).not.toBe(video.calls[0]!.variant);
      expect(r.attempts.find((a) => a.stage === "regen")).toMatchObject({ ok: true });
      expect(judgeAttempts(r.attempts).map((a) => a.score)).toEqual([2, 7]);
      expect(r.clipScore).toBe(7);
      expect(r.needsReview).toBe(false);
      expect(r.path).toBe(video.calls[1]!.out.replace(/\.tmp-[^.]+/, "")); // take 2's file
      expect(r.verbatim?.pass).toBe(true);
    },
    SLOW,
  );

  it(
    "3c. only one regeneration: two low takes keep the better and need review",
    async () => {
      const dir = fresh();
      const portrait = await portraitIn(dir);
      const rig = shotRig(dir, { video: [4, 3], fallback: 1 });
      const r = await judgedTalkingShot(S1, portrait, { ...rig, portrait });
      expect(rig.video.calls).toHaveLength(2);
      expect(r.clipScore).toBe(4);
      expect(r.needsReview).toBe(true);
      expect(r.attempts.at(-1)!.reason).toMatch(/kept take 1; needs review/);
    },
    SLOW,
  );

  it(
    "4b. an invalid clip verdict is a judge failure: recorded, not a pass, so the shot is regenerated",
    async () => {
      const dir = fresh();
      const portrait = await portraitIn(dir);
      const rig = shotRig(dir, { video: [{ raw: { score: "great", issues: [] } }, 9] });
      const r = await judgedTalkingShot(S1, portrait, { ...rig, portrait });
      const judged = judgeAttempts(r.attempts);
      expect(judged[0]).toMatchObject({ ok: false });
      expect(judged[0]!.reason).toMatch(/judge output invalid/);
      expect(r.attempts.find((a) => a.stage === "regen")!.reason).toMatch(/clip judge failed/);
      expect(rig.video.calls).toHaveLength(2);
      expect(r.clipScore).toBe(9);
      expect(r.needsReview).toBe(false);
    },
    SLOW,
  );
});

describe("pipeline: scores reach the manifest", () => {
  const IDEA = `A man on a rooftop calls his brother. He says: "${LINE}"`;
  async function run(judgeOpts: ConstructorParameters<typeof MockJudge>[0]) {
    const runsDir = fresh();
    const out: string[] = [];
    const j = new MockJudge(judgeOpts);
    const code = await main([IDEA, "--mock", "--json"], { runsDir, overrides: { judge: j }, stdout: (l) => out.push(l), stderr: () => {} });
    const s = JSON.parse(out.at(-1)!) as { manifest: string };
    const manifest = RunManifest.parse(JSON.parse(await readFile(s.manifest, "utf8")));
    return { code, manifest, judge: j };
  }

  it(
    "keyframe 4 → 8 in the graph: both scores in attempts, kept score on the shot, no review",
    async () => {
      const { code, manifest } = await run({ image: [{ score: 4, issues: [ISSUE] }, 8] });
      expect(code).toBe(0);
      const s1 = manifest.attempts.filter((a) => a.stage === "judge" && a.shotId === "s1");
      expect(s1.map((a) => a.score)).toEqual([4, 8, 8]); // keyframe ×2, clip ×1
      expect(manifest.shots?.s1).toMatchObject({ keyframeScore: 8, clipScore: 8, needsReview: false });
      expect(manifest.shots?.s2).toMatchObject({ keyframeScore: 8, clipScore: 8, needsReview: false });
    },
    SLOW,
  );

  it(
    "an always-low judge still delivers a verbatim video, with every shot marked needsReview",
    async () => {
      const { code, manifest, judge: j } = await run({ fallback: 3 });
      expect(code).toBe(0);
      expect(manifest.verbatim?.pass).toBe(true);
      expect(manifest.shots?.s1?.needsReview).toBe(true);
      expect(manifest.shots?.s2?.needsReview).toBe(true);
      expect(j.calls.filter((c) => c.kind === "image")).toHaveLength(6); // 2 shots × (1 + 2 extra)
      expect(j.calls.filter((c) => c.kind === "video")).toHaveLength(4); // 2 shots × (1 + 1 regeneration)
    },
    SLOW,
  );
});
