import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseArgs, subtitlesFromEnv } from "../src/cli.ts";
import { carriedAttempts, endedManifest, estimateRunUsd, isTransient, markEndedSync, originalCostLookup } from "../src/graph.ts";
import { loudnormArgs, parseLoudnorm, segmentArgs } from "../src/media/args.ts";
import { probe } from "../src/media/ffmpeg.ts";
import { cutSeconds, END_FADE, SPEECH_TAIL } from "../src/nodes/assemble.ts";
import { expectedSpeech, probeProblems } from "../src/nodes/final-gate.ts";
import { scriptProblems } from "../src/nodes/script.ts";
import { ShotError } from "../src/nodes/visuals.ts";
import { firstPrompt } from "../src/prompts/script.ts";
import { applyAsrFault } from "../src/providers/mock.ts";
import {
  Budget,
  BudgetExceededError,
  createProviders,
  HttpError,
  maxCostFromEnv,
  MOCK_DEFAULT_LINE,
  MockAsr,
  MockImage,
  MockLlm,
  MockVideo,
  mockScriptResponder,
  withBudget,
  type AnimateRequest,
  type AnimateResult,
  type ImageRequest,
  type LlmRequest,
  type LlmResult,
} from "../src/providers/index.ts";
import { RunManifest, Script, SCRIPT_SECONDS, type Attempt, type ScriptDraft } from "../src/schemas.ts";
import { linkSources, readTranscript, writeTranscript } from "../src/util/sidecar.ts";
import { extractQuotedLines } from "../src/verbatim.ts";

const LINE = "I kept the watch. I kept everything.";
const IDEA = `A man on a rooftop calls his brother. He says: "${LINE}"`;
const SLOW = 90_000;
const FAST_RETRY = { initialInterval: 1, jitter: false };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "itv-graph-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Summary {
  ok: boolean;
  runId: string;
  finalPath: string | null;
  seconds: number | null;
  verbatim: { wer: number; expected: string; heard: string } | null;
  costUsd: number;
  attempts: number;
  manifest: string;
  error?: string;
}

/** Runs the CLI in-process; returns exit code, the parsed --json line, stderr lines and the manifest on disk. */
async function cli(argv: string[], deps: Parameters<typeof main>[1] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, "--json"], {
    runsDir: join(dir, "runs"),
    env: {},
    retry: FAST_RETRY,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...deps,
  });
  const json = JSON.parse(out.at(-1)!) as Summary;
  const manifest = json.manifest ? RunManifest.parse(JSON.parse(await readFile(json.manifest, "utf8"))) : undefined;
  return { code, json, err, manifest };
}

// --- pure pieces ---

describe("cli args", () => {
  it("defaults to mock, takes one idea, --resume <id>, --json", () => {
    expect(parseArgs(["an idea"])).toEqual({ idea: "an idea", json: false });
    expect(parseArgs(["an idea", "--live", "--json"])).toEqual({ idea: "an idea", mode: "live", json: true });
    expect(parseArgs(["--resume", "r1"])).toEqual({ resume: "r1", json: false });
  });
  it("rejects what it doesn't understand", () => {
    expect(() => parseArgs([])).toThrow(/idea is required/);
    expect(() => parseArgs(["a", "--mock", "--live"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["a", "--fast"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--resume"])).toThrow(/needs a run id/);
    expect(() => parseArgs(["a", "b"])).toThrow(/one idea/);
    expect(() => parseArgs(["--resume", "r1", "--mock"])).toThrow(/own mode/);
    expect(parseArgs(["--resume", "r1", "--redo", "shot"])).toEqual({ resume: "r1", redo: "shot", json: false });
    expect(() => parseArgs(["--resume", "r1", "--redo", "nope"])).toThrow(/--redo needs a step/);
    expect(() => parseArgs(["idea", "--redo", "shot"])).toThrow(/--redo needs --resume/);
  });
  it("usage errors exit 2 without running anything", async () => {
    const err: string[] = [];
    expect(await main(["--bogus"], { stderr: (l) => err.push(l), stdout: () => {} })).toBe(2);
    expect(err.join("\n")).toMatch(/usage: pnpm make/);
  });
  it("MAX_COST_USD: default 3, must be a non-negative number", () => {
    expect(maxCostFromEnv({})).toBe(3);
    expect(maxCostFromEnv({ MAX_COST_USD: "0.5" })).toBe(0.5);
    expect(() => maxCostFromEnv({ MAX_COST_USD: "lots" })).toThrow(/MAX_COST_USD/);
    expect(() => maxCostFromEnv({ MAX_COST_USD: "-1" })).toThrow(/MAX_COST_USD/);
  });
});

describe("F20: --fresh-takes", () => {
  it("parses only with --redo shot", () => {
    expect(parseArgs(["--resume", "r1", "--redo", "shot", "--fresh-takes"])).toMatchObject({ resume: "r1", redo: "shot", freshTakes: true });
    expect(() => parseArgs(["--resume", "r1", "--redo", "assemble", "--fresh-takes"])).toThrow(/--fresh-takes needs/);
    expect(() => parseArgs(["an idea", "--fresh-takes"])).toThrow(/--fresh-takes needs/);
  });

  it("freshShots: only shots with no verified result, each after the highest video attempt it used", async () => {
    const { freshShots } = await import("../src/graph.ts");
    const script = { shots: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] } as unknown as Script;
    const a = (shotId: string, n: number, stage = "video"): Attempt => ({ stage, shotId: shotId as Attempt["shotId"], n, provider: "p", ok: false, costUsd: 0, ms: 0 });
    const got = freshShots(script, { s1: {} }, [a("s1", 1), a("s2", 1), a("s2", 2), a("s2", 4, "judge"), a("s3", 1, "voice")]);
    expect([...got]).toEqual([["s2", 2], ["s3", 0]]);
  });
});

describe("isTransient", () => {
  it("429/5xx/network/timeouts are transient, also when wrapped as a cause", () => {
    expect(isTransient(new HttpError("x", 429, ""))).toBe(true);
    expect(isTransient(new HttpError("x", 503, ""))).toBe(true);
    expect(isTransient(new ShotError("s1", "video error", [], { cause: new HttpError("x", 502, "") }))).toBe(true);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("socket"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("slow"), { name: "TimeoutError" }))).toBe(true);
  });
  it("4xx, bugs, budget stops and quality failures are not", () => {
    expect(isTransient(new HttpError("x", 400, ""))).toBe(false);
    expect(isTransient(new ShotError("s1", "bad", [], { cause: new HttpError("x", 401, "") }))).toBe(false);
    expect(isTransient(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isTransient(new BudgetExceededError("v", 1, 0, 0.5))).toBe(false);
    expect(isTransient(new Error("boom"))).toBe(false);
  });
});

describe("assembly helpers", () => {
  it("cutSeconds: script length, stretched to the last word + tail, never past the clip", () => {
    expect(cutSeconds(5, 6, 3)).toBe(5);
    expect(cutSeconds(5, 6, 4.9)).toBe(Number((4.9 + SPEECH_TAIL).toFixed(3)));
    expect(cutSeconds(5, 5.2, 4.9)).toBe(5.2);
    expect(cutSeconds(4, 4)).toBe(4);
  });
  it("segmentArgs: exact frames, fades on both edges, silence generated for a silent clip", () => {
    const a = segmentArgs({ input: "i.mp4", out: "o.mp4", seconds: 4, audio: false, fade: 0.05 });
    expect(a).toContain("anullsrc=r=48000:cl=stereo");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("120");
    expect(a[a.indexOf("-map", a.indexOf("-map") + 1) + 1]).toBe("1:a:0");
    const af = a[a.indexOf("-af") + 1]!;
    expect(af).toContain("afade=t=in:st=0:d=0.05");
    expect(af).toContain("afade=t=out:st=3.95:d=0.05");
    const b = segmentArgs({ input: "i.mp4", out: "o.mp4", seconds: 4, audio: true, fade: 0.05 });
    expect(b).not.toContain("anullsrc=r=48000:cl=stereo");
    expect(b[b.indexOf("-map", b.indexOf("-map") + 1) + 1]).toBe("0:a:0");
    expect(() => segmentArgs({ input: "i", out: "o", seconds: 0.05, audio: true, fade: 0.05 })).toThrow(RangeError);
  });
  it("segmentArgs: a 200 ms end fade-out on top of the 50 ms edge fades (F11, Seedance end-of-clip click)", () => {
    const a = segmentArgs({ input: "i.mp4", out: "o.mp4", seconds: 4, audio: true, fade: 0.05, endFade: 0.2 });
    const af = a[a.indexOf("-af") + 1]!;
    expect(af).toContain("afade=t=in:st=0:d=0.05,afade=t=out:st=3.95:d=0.05,afade=t=out:st=3.8:d=0.2");
    expect(() => segmentArgs({ input: "i", out: "o", seconds: 1, audio: true, fade: 0.05, endFade: 1 })).toThrow(/endFade/);
    expect(END_FADE).toBe(0.2);
  });
  it("loudnorm: two-pass linear with the measured values", () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n "input_i" : "-36.40", "input_tp" : "-35.00", "input_lra" : "0.00",
      "input_thresh" : "-46.40", "output_i" : "-24.0", "target_offset" : "0.10" }\n`;
    const m = parseLoudnorm(stderr);
    expect(m).toEqual({ input_i: "-36.40", input_tp: "-35.00", input_lra: "0.00", input_thresh: "-46.40", target_offset: "0.10" });
    const af = loudnormArgs({ input: "i", out: "o", silent: false, measured: m })[3]!;
    expect(af).toMatch(/^loudnorm=I=-16:TP=-1\.5:LRA=11:measured_I=-36\.40:.*offset=0\.10:linear=true/);
    expect(() => parseLoudnorm("no audio here")).toThrow(/no measurement/);
  });
  it("transcript links: pieces are shifted to their offset and cut where the piece ends", async () => {
    const a = join(dir, "a.wav");
    const b = join(dir, "b.wav");
    await writeFile(a, "");
    await writeFile(b, "");
    await writeTranscript(a, { text: "one two", words: [{ word: "one", start: 0.2, end: 0.5 }, { word: "two", start: 3.5, end: 3.9 }] });
    await writeTranscript(b, { text: "three", words: [{ word: "three", start: 0.1, end: 0.4 }] });
    const cut = join(dir, "cut.mp4");
    await linkSources(cut, [{ source: a, until: 3 }]);
    const cat = join(dir, "cat.mp4");
    await linkSources(cat, [{ source: cut, offset: 0 }, { source: b, offset: 3 }]);
    expect(await readTranscript(cat)).toEqual({
      text: "one three",
      words: [{ word: "one", start: 0.2, end: 0.5 }, { word: "three", start: 3.1, end: 3.4 }],
    });
  });
});

describe("final gate checks", () => {
  it("expected speech is every line in order, delivery tags dropped, silent shots skipped", () => {
    const draft = mockScriptResponder(firstPrompt(IDEA, extractQuotedLines(IDEA)), { system: "", call: 0 }) as ScriptDraft;
    const script = Script.parse({ ...draft, promptVersion: "t", quotedLines: [LINE] });
    expect(expectedSpeech(script)).toBe(LINE);
    const two = { ...script, shots: [{ ...script.shots[0]!, line: "[whispers] Wait." }, script.shots[1]!] };
    expect(expectedSpeech(two)).toBe(`Wait. ${LINE}`);
  });
  it("probe: 8–30 s, 1080×1920, audio", () => {
    const good = { seconds: 9, width: 1080, height: 1920, hasAudio: true, hasVideo: true };
    expect(probeProblems(good)).toEqual([]);
    expect(probeProblems({ ...good, seconds: 7.9 })[0]).toMatch(/duration 7\.90 s is outside 8–30/);
    expect(probeProblems({ ...good, width: 720 })[0]).toMatch(/720×1920/);
    expect(probeProblems({ ...good, hasAudio: false })).toEqual(["no audio track"]);
  });
});

describe("mock script writer", () => {
  it.each([
    [IDEA],
    ['She whispers "Wait." and then "Don\'t go."'],
    ["A barista closes up alone."],
  ])("writes a script that passes every check: %s", (idea) => {
    const quoted = extractQuotedLines(idea);
    const draft = mockScriptResponder(firstPrompt(idea, quoted), { system: "", call: 0 }) as ScriptDraft;
    const script = Script.parse({ ...draft, promptVersion: "t", quotedLines: quoted });
    expect(scriptProblems(script, idea)).toEqual([]);
    if (!quoted.length) expect(script.shots.map((s) => s.line)).toContain(MOCK_DEFAULT_LINE);
  });
});

describe("budget", () => {
  it("refuses a call whose estimate would cross the cap, before calling", async () => {
    const b = new Budget(0.01);
    let called = 0;
    await expect(b.guard("v", 0.02, async () => (called++, { costUsd: 0.02 }))).rejects.toThrow(BudgetExceededError);
    expect(called).toBe(0);
    await b.guard("free", 0, async () => (called++, { costUsd: 0 }));
    expect(called).toBe(1);
  });
  it("books actual cost and counts in-flight reservations", async () => {
    const b = new Budget(1, 0.5);
    let release!: () => void;
    const slow = b.guard("a", 0.4, () => new Promise<{ costUsd: number }>((r) => (release = () => r({ costUsd: 0.3 }))));
    await expect(b.guard("b", 0.2, async () => ({ costUsd: 0.2 }))).rejects.toThrow(/in flight/);
    release();
    await slow;
    expect(b.spentUsd).toBeCloseTo(0.8);
  });
  it("withBudget keeps capabilities and limits visible", () => {
    const p = withBudget(createProviders({ mode: "mock", env: {} }), new Budget(1));
    expect(p.video.capabilities.nativeSpeech).toBe(true);
    expect(p.lipsync.maxSeconds).toBe(Infinity);
    expect(p.video.name).toBe("mock-video");
  });
});

// --- fakes for the pipeline runs ---

/** Mock video that throws `err` on the given 0-based calls (before doing anything, like a failed HTTP request). */
class FlakyVideo extends MockVideo {
  attemptsMade = 0;
  constructor(private readonly failOn: Map<number, Error>) {
    super();
  }
  override async animate(req: AnimateRequest): Promise<AnimateResult> {
    const err = this.failOn.get(this.attemptsMade++);
    if (err) throw err;
    return super.animate(req);
  }
}

/** Hears the final file with one word swapped; every shot-level check still passes. */
class FinalMishearingAsr extends MockAsr {
  override async transcribe(req: { path: string }) {
    const r = await super.transcribe(req);
    if (!req.path.endsWith("final.mp4")) return r;
    return { ...applyAsrFault(r, { call: 0, replace: { watch: "clock" } }), costUsd: r.costUsd };
  }
}

// Live-priced fakes: free mocks underneath, but they quote and bill like paid APIs.
class PricedLlm extends MockLlm {
  estimateUsd() {
    return 0.02;
  }
  override async generateJson<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    return { ...(await super.generateJson(req)), costUsd: 0.015 };
  }
}
class PricedImage extends MockImage {
  estimateUsd() {
    return 0.04;
  }
  override async generate(req: ImageRequest) {
    return { ...(await super.generate(req)), costUsd: 0.04 };
  }
}
class PricedVideo extends MockVideo {
  estimateUsd(req: AnimateRequest) {
    return 0.3 * req.seconds;
  }
  override async animate(req: AnimateRequest) {
    return { ...(await super.animate(req)), costUsd: 0.3 * req.seconds };
  }
}

/** F19: a video model that bills $0.60 per clip (two shots → $1.20), free underneath. */
class PaidVideo extends MockVideo {
  override async animate(req: AnimateRequest) {
    return { ...(await super.animate(req)), costUsd: 0.6 };
  }
}

// --- acceptance: whole pipeline on mocks ---

describe("pipeline (mock providers, real ffmpeg)", () => {
  it(
    "1. the acceptance idea: exit 0, 8–30 s, wer 0, the quoted line verbatim; a valid manifest and 1080×1920 file",
    async () => {
      const { code, json, manifest } = await cli([IDEA, "--mock"]);
      expect(code).toBe(0);
      expect(json.ok).toBe(true);
      expect(json.seconds).toBeGreaterThanOrEqual(SCRIPT_SECONDS.min);
      expect(json.seconds).toBeLessThanOrEqual(SCRIPT_SECONDS.max);
      expect(json.verbatim?.wer).toBe(0);
      expect(json.verbatim?.expected).toContain(LINE);
      expect(json.verbatim?.heard).toContain(LINE);
      expect(json.finalPath).toMatch(new RegExp(`${json.runId}/final\\.mp4$`));

      const p = await probe(json.finalPath!);
      expect(p).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
      expect(Math.abs(p.seconds - json.seconds!)).toBeLessThan(0.01);

      expect(manifest?.ok).toBe(true);
      expect(manifest?.verbatim?.pass).toBe(true);
      expect(Object.keys(manifest?.shots ?? {})).toEqual(["s1", "s2"]);
      expect(manifest?.shots?.s1?.audio).toBe("silent");
      expect(manifest?.shots?.s2?.audio).toBe("native");
      const stages = manifest!.attempts.map((a) => a.stage);
      for (const s of ["script", "portrait", "keyframe", "video", "assemble", "final"]) expect(stages).toContain(s);
    },
    SLOW,
  );

  it(
    "2. resume after a crash past the keyframes: finished stages call no provider again",
    async () => {
      const first = { llm: new MockLlm({ responder: mockScriptResponder }), image: new MockImage(), video: new MockVideo() };
      const crashed = await cli([IDEA, "--mock"], {
        overrides: first,
        beforeNode: (node) => {
          if (node === "shot") throw new Error("simulated crash after keyframes");
        },
      });
      expect(crashed.code).not.toBe(0);
      expect(crashed.json.ok).toBe(false);
      expect(crashed.manifest?.error).toMatch(/simulated crash/);
      expect(crashed.manifest?.script).toBeDefined();
      // F19: a crash ends the run as failed, with an end time.
      expect(crashed.manifest?.status).toBe("failed");
      expect(crashed.manifest?.endedAt).toBeDefined();
      expect(first.llm.calls).toHaveLength(1);
      expect(first.image.calls).toHaveLength(3); // portrait + 2 keyframes
      expect(first.video.calls).toHaveLength(0);

      const second = { llm: new MockLlm({ responder: mockScriptResponder }), image: new MockImage(), video: new MockVideo() };
      const resumed = await cli(["--resume", crashed.json.runId], { overrides: second });
      expect(resumed.code).toBe(0);
      expect(resumed.json.ok).toBe(true);
      expect(resumed.json.runId).toBe(crashed.json.runId);
      expect(second.llm.calls).toHaveLength(0);
      expect(second.image.calls).toHaveLength(0);
      expect(second.video.calls).toHaveLength(2);
      // The crash is still on record, and the script attempt isn't duplicated.
      expect(resumed.manifest?.attempts.filter((a) => a.stage === "script")).toHaveLength(1);
      expect(resumed.manifest?.attempts.some((a) => a.reason?.includes("simulated crash"))).toBe(true);
      expect(resumed.manifest?.error).toBeUndefined();
      expect(resumed.manifest?.status).toBe("done");
      // The resume restarts the clock: the timer shows this process, not the crashed one.
      expect(Date.parse(resumed.manifest!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(crashed.manifest!.endedAt!));
    },
    SLOW,
  );

  it(
    "2b. --redo shot replays a finished run from the shots: no script, image or video call, files reused",
    async () => {
      const first = await cli([IDEA, "--mock"], {});
      expect(first.json.ok).toBe(true);
      const again = { llm: new MockLlm({ responder: mockScriptResponder }), image: new MockImage(), video: new MockVideo() };
      const redone = await cli(["--resume", first.json.runId, "--redo", "shot"], { overrides: again });
      expect(redone.code).toBe(0);
      expect(redone.json.ok).toBe(true);
      expect(redone.json.runId).toBe(first.json.runId);
      expect(again.llm.calls).toHaveLength(0);
      expect(again.image.calls).toHaveLength(0);
      expect(again.video.calls).toHaveLength(0); // content-addressed clips: a paid clip is never bought twice
      expect(redone.manifest?.attempts.filter((a) => a.stage === "video").every((a) => /reused cached clip/.test(a.reason ?? ""))).toBe(true);
    },
    SLOW,
  );

  it(
    "F19-1. the manifest is `running` with startedAt while the graph runs, then `done` with endedAt",
    async () => {
      const runId = "f19-status-1";
      const path = join(dir, "runs", runId, "manifest.json");
      const seen: RunManifest[] = [];
      const { code, manifest, json } = await cli([IDEA, "--mock", "--run-id", runId], {
        beforeNode: async (node) => {
          if (node === "writeScript" || node === "assemble") seen.push(RunManifest.parse(JSON.parse(await readFile(path, "utf8"))));
        },
      });
      expect(json.error).toBeUndefined();
      expect(code).toBe(0);
      expect(seen).toHaveLength(2);
      for (const m of seen) {
        expect(m.status).toBe("running");
        expect(m.ok).toBe(false);
        expect(m.startedAt).toBeDefined();
        expect(m.endedAt).toBeUndefined();
      }
      expect(manifest?.status).toBe("done");
      expect(manifest?.startedAt).toBe(seen[0]!.startedAt);
      expect(Date.parse(manifest!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(manifest!.startedAt!));
    },
    SLOW,
  );

  it("F19-1b. endedManifest closes only a running manifest; markEndedSync rewrites the file", async () => {
    const base = RunManifest.parse({ runId: "x", idea: "i", mode: "mock", createdAt: "2026-10-19T10:00:00.000Z", attempts: [], costUsd: 0, ok: false });
    const now = new Date("2026-10-19T10:05:00.000Z");
    const running = { ...base, status: "running" as const, startedAt: "2026-10-19T10:00:00.000Z" };
    expect(endedManifest(running, "interrupted by SIGTERM", now)).toMatchObject({ status: "failed", ok: false, endedAt: now.toISOString(), error: "interrupted by SIGTERM" });
    const done = { ...base, ok: true, status: "done" as const, endedAt: "2026-10-19T10:01:00.000Z" };
    expect(endedManifest(done, "late signal", now)).toBe(done);
    const file = join(dir, "ended.json");
    await writeFile(file, JSON.stringify(running));
    markEndedSync(file, "crashed: boom");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ status: "failed", error: "crashed: boom" });
    markEndedSync(join(dir, "missing.json"), "no file"); // never throws
  });

  it(
    "F19-1c. a CLI process killed with SIGTERM leaves its manifest failed, with endedAt",
    async () => {
      const runsDir = join(dir, "sig-runs");
      const runId = "f19-sigterm";
      const path = join(runsDir, runId, "manifest.json");
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--mock", "--json", "--run-id", runId, "--", IDEA], {
        cwd: join(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH, RUNS_DIR: runsDir },
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
      let status: string | undefined;
      for (let i = 0; i < 400 && status !== "running"; i++) {
        await new Promise((r) => setTimeout(r, 25));
        status = await readFile(path, "utf8").then((t) => (JSON.parse(t) as RunManifest).status, () => undefined);
      }
      expect(status).toBe("running");
      child.kill("SIGTERM");
      expect(await exited).toBe(143);
      const m = RunManifest.parse(JSON.parse(await readFile(path, "utf8")));
      expect(m).toMatchObject({ status: "failed", ok: false, error: "interrupted by SIGTERM" });
      expect(m.endedAt).toBeDefined();
    },
    SLOW,
  );

  it(
    "F19-3. --redo after a run that paid $1.20 keeps the spend: carried attempts, costUsd ≥ 1.20, one redo listed",
    async () => {
      const runId = "f19-redo-paid";
      const env = { MAX_COST_USD: "5" };
      const paid = new PaidVideo();
      const first = await cli([IDEA, "--mock", "--run-id", runId], { overrides: { video: paid }, env });
      expect(first.json.ok).toBe(true);
      expect(paid.calls).toHaveLength(2);
      expect(first.manifest?.costUsd).toBeCloseTo(1.2, 6);

      const again = new PaidVideo();
      const redone = await cli(["--resume", runId, "--redo", "shot"], { overrides: { video: again }, env });
      expect(redone.json.ok).toBe(true);
      expect(again.calls).toHaveLength(0); // all clips cached
      const m = redone.manifest!;
      expect(m.costUsd).toBeGreaterThanOrEqual(1.2);
      expect(m.costUsd).toBeCloseTo(first.manifest!.costUsd, 6);
      expect(redone.json.costUsd).toBeCloseTo(m.costUsd, 6);
      expect(m.status).toBe("done");
      expect(m.redos).toHaveLength(1);
      expect(m.redos![0]).toMatchObject({ from: "shot", costUsd: 0 });
      const carried = m.attempts.filter((a) => a.carried);
      expect(carried.length).toBeGreaterThan(0);
      expect(carried.every((a) => a.costUsd > 0)).toBe(true);
      expect(carried.filter((a) => a.stage === "video").reduce((s, a) => s + a.costUsd, 0)).toBeCloseTo(1.2, 6);
      // The redo's own video attempts are the $0 reuse, beside the carried ones.
      const own = m.attempts.filter((a) => a.stage === "video" && !a.carried);
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((a) => a.costUsd === 0 && /reused cached clip/.test(a.reason ?? ""))).toBe(true);

      // The trace marks the reused clips cached, with what they cost when bought.
      const spans = (await readFile(join(dir, "runs", runId, "trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind: string; cached?: boolean; originalCostUsd?: number; shotId?: string });
      const reused = spans.filter((s) => s.kind === "video" && s.cached);
      expect(reused.map((s) => s.shotId).sort()).toEqual(["s1", "s2"]);
      expect(reused.every((s) => s.originalCostUsd === 0.6)).toBe(true);

      // A second redo neither loses nor double-counts the carried spend.
      const twice = await cli(["--resume", runId, "--redo", "shot"], { overrides: { video: new PaidVideo() }, env });
      expect(twice.manifest?.costUsd).toBeCloseTo(first.manifest!.costUsd, 6);
      expect(twice.manifest?.redos).toHaveLength(2);
    },
    SLOW,
  );

  it("F19-3b. carriedAttempts keeps only the paid tail past the fork; originalCostLookup answers each price once", () => {
    const a = (stage: string, costUsd: number, extra: Partial<Attempt> = {}): Attempt => ({ stage, n: 1, provider: "p", ok: true, costUsd, ms: 1, ...extra });
    const prev = RunManifest.parse({
      runId: "x",
      idea: "i",
      mode: "mock",
      createdAt: "2026-10-19T10:00:00.000Z",
      attempts: [
        a("script", 0.1),
        a("video", 0.6, { shotId: "s1" }),
        a("judge", 0),
        a("video", 0.6, { shotId: "s2", provider: "p+asr" }),
        a("video", 0.2, { shotId: "s2", ok: false }),
      ],
      costUsd: 1.5,
      ok: true,
    });
    const carried = carriedAttempts(prev, 1);
    expect(carried.map((x) => [x.stage, x.shotId, x.costUsd, x.carried])).toEqual([
      ["video", "s1", 0.6, true],
      ["video", "s2", 0.6, true],
      ["video", "s2", 0.2, true],
    ]);
    expect(carriedAttempts(undefined, 0)).toEqual([]);
    const lookup = originalCostLookup(carried);
    expect(lookup("asr", "asr", "s2")).toBeUndefined(); // an ASR cache hit never takes the clip's price
    expect(lookup("video", "p", "s2")).toBe(0.6); // "p+asr": the video provider is one of the parts
    expect(lookup("video", "p", "s2")).toBeUndefined(); // the failed take is no artifact's price
    expect(lookup("video", "other", "s1")).toBeUndefined();
    expect(lookup("image", "p", "s1")).toBeUndefined();
    expect(lookup("video", "p", "s1")).toBe(0.6);
  });

  it(
    "3. the final file mis-heard by one word → ok:false, exit ≠ 0, the manifest says which word",
    async () => {
      const { code, json, manifest } = await cli([IDEA, "--mock"], { overrides: { asr: new FinalMishearingAsr() } });
      expect(code).not.toBe(0);
      expect(json.ok).toBe(false);
      expect(json.verbatim?.wer).toBeGreaterThan(0);
      expect(json.verbatim?.heard).toContain("clock");
      expect(manifest?.ok).toBe(false);
      expect(manifest?.verbatim?.pass).toBe(false);
      expect(manifest?.error).toMatch(/final gate: not verbatim .*"watch" heard as "clock"/);
      // The shots themselves passed: only the final gate caught it.
      expect(manifest?.shots?.s2?.verbatim?.pass).toBe(true);
      const final = manifest!.attempts.find((a) => a.stage === "final");
      expect(final).toMatchObject({ ok: false });
      expect(final?.reason).toMatch(/clock/);
    },
    SLOW,
  );

  it(
    "4a. a transient error on the first video call is retried with backoff and recorded",
    async () => {
      const video = new FlakyVideo(new Map([[0, new HttpError("fake-video", 503, "busy")]]));
      const { code, json, manifest } = await cli([IDEA, "--mock"], { overrides: { video } });
      expect(code).toBe(0);
      expect(json.ok).toBe(true);
      expect(video.attemptsMade).toBe(3); // 1 failed + 2 shots
      const retry = manifest!.attempts.filter((a) => a.stage === "retry");
      expect(retry).toHaveLength(1);
      expect(retry[0]!.reason).toMatch(/transient .*HTTP 503.*retrying with backoff/);
      expect(manifest!.attempts.some((a) => a.stage === "video" && !a.ok && /HTTP 503/.test(a.reason ?? ""))).toBe(true);
    },
    SLOW,
  );

  it(
    "4b. a permanent error fails the run cleanly: no retry, ok:false, readable error, manifest written",
    async () => {
      const video = new FlakyVideo(new Map([[0, new HttpError("fake-video", 400, "bad prompt")]]));
      const { code, json, manifest } = await cli([IDEA, "--mock"], { overrides: { video } });
      expect(code).not.toBe(0);
      expect(json.ok).toBe(false);
      expect(video.attemptsMade).toBeLessThanOrEqual(2); // the other shot may run in parallel; nothing is retried
      expect(manifest?.ok).toBe(false);
      expect(manifest?.error).toMatch(/HTTP 400/);
      expect(manifest!.attempts.filter((a) => a.stage === "retry")).toHaveLength(0);
      expect(manifest!.attempts.some((a) => a.stage === "video" && !a.ok && /HTTP 400/.test(a.reason ?? ""))).toBe(true);
      expect(manifest?.final).toBeUndefined();
    },
    SLOW,
  );

  it(
    "5. budget guard: MAX_COST_USD=0.01 with live-priced fakes aborts before the first paid call",
    async () => {
      const priced = {
        llm: new PricedLlm({ responder: mockScriptResponder }),
        image: new PricedImage(),
        video: new PricedVideo(),
        tts: createProviders({ mode: "mock", env: {} }).tts,
        asr: new MockAsr(),
        lipsync: createProviders({ mode: "mock", env: {} }).lipsync,
        talking: createProviders({ mode: "mock", env: {} }).talking,
        judge: createProviders({ mode: "mock", env: {} }).judge,
      };
      // Not a real live run: every capability is overridden, so no key is read and nothing leaves the machine.
      const { code, json, err, manifest } = await cli([IDEA, "--live"], { overrides: priced, env: { MAX_COST_USD: "0.01" } });
      expect(code).not.toBe(0);
      expect(json.ok).toBe(false);
      expect(priced.llm.calls).toHaveLength(0);
      expect(priced.image.calls).toHaveLength(0);
      expect(priced.video.calls).toHaveLength(0);
      expect(manifest?.error).toMatch(/budget: mock-llm call would cost ~\$0\.0200 .* over MAX_COST_USD=\$0\.01/);
      expect(manifest?.costUsd).toBe(0);
      expect(err.join("\n")).toMatch(/estimated ~\$\d+\.\d\d for a typical run; MAX_COST_USD=\$0\.01/);
      expect(estimateRunUsd(priced, IDEA)).toBeCloseTo(0.02 + 3 * 0.04 + 2 * 0.3 * 8);
      // F12: a 4-beat storyboard is 4 shots (portrait + 4 keyframes), at most 30 s in total (4 × 7 s).
      const four = 'Shot 1: a gate. Shot 2: a hall. Shot 3: a stair. Shot 4: she says: "Hello?"';
      expect(estimateRunUsd(priced, four)).toBeCloseTo(0.02 + 5 * 0.04 + 4 * 0.3 * 7);
    },
    SLOW,
  );

  it(
    "5b. the same priced fakes under a sufficient cap run through, and the manifest adds up their cost",
    async () => {
      const priced = { llm: new PricedLlm({ responder: mockScriptResponder }), image: new PricedImage(), video: new PricedVideo() };
      const { code, json, manifest } = await cli([IDEA, "--mock"], { overrides: priced, env: { MAX_COST_USD: "5" } });
      expect(code).toBe(0);
      const videoSeconds = priced.video.calls.reduce((s, c) => s + c.seconds, 0);
      // Two LLM calls (F18): the writer and the continuity critic, each priced 0.015.
      expect(json.costUsd).toBeCloseTo(2 * 0.015 + 3 * 0.04 + 0.3 * videoSeconds, 6);
      expect(manifest?.costUsd).toBeCloseTo(json.costUsd, 6);
    },
    SLOW,
  );
});

// --- F13: burned-in subtitles ---

const execFileP = promisify(execFile);

/** The lower third of one frame as raw RGB bytes (small, so two files can be compared byte for byte). */
async function lowerThird(file: string, at: number): Promise<Buffer> {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "crop=1080:640:0:1280,scale=270:160", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout as Buffer;
}

describe("subtitles (F13)", () => {
  const BARISTA_LINE = "Meet me where it started.";
  const BARISTA = `A tired barista finds a note in the tip jar: "${BARISTA_LINE}"`;

  it("--no-subtitles and SUBTITLES=0 turn them off; default on", () => {
    expect(parseArgs(["an idea", "--no-subtitles"])).toEqual({ idea: "an idea", json: false, subtitles: false });
    expect(subtitlesFromEnv({})).toBe(true);
    expect(subtitlesFromEnv({ SUBTITLES: "0" })).toBe(false);
    expect(subtitlesFromEnv({ SUBTITLES: "1" })).toBe(true);
  });

  it(
    "4. the barista idea: ok, cues join to the line, the burned file differs in the lower third, both pass the final gate",
    async () => {
      const on = await cli([BARISTA, "--mock"]);
      const off = await cli([BARISTA, "--mock", "--no-subtitles"]);
      for (const r of [on, off]) {
        expect(r.code).toBe(0);
        expect(r.json.ok).toBe(true);
        expect(r.json.verbatim?.wer).toBe(0);
        expect(r.manifest!.attempts.find((a) => a.stage === "final")).toMatchObject({ ok: true });
      }
      const subs = on.manifest!.subtitles!;
      expect(subs.timing).toBe("asr");
      expect(subs.cues.map((c) => c.text).join(" ")).toBe(BARISTA_LINE);
      expect(off.manifest!.subtitles).toBeUndefined();
      expect(off.manifest!.attempts.find((a) => a.stage === "subtitles")?.reason).toMatch(/off/);
      // The final gate listened to the burned file, and it is the one in the manifest.
      expect(on.json.finalPath).toMatch(/final\.mp4$/);
      const mid = (subs.cues[0]!.start + subs.cues[0]!.end) / 2;
      const [a, b] = await Promise.all([lowerThird(on.json.finalPath!, mid), lowerThird(off.json.finalPath!, mid)]);
      expect(a.length).toBe(b.length);
      expect(a.equals(b)).toBe(false);
      // Outside every cue the two films are the same picture (subtitles only, nothing else changed).
      const before = subs.cues[0]!.start / 2;
      const [c, d] = await Promise.all([lowerThird(on.json.finalPath!, before), lowerThird(off.json.finalPath!, before)]);
      let diff = 0;
      for (let i = 0; i < c.length; i++) diff = Math.max(diff, Math.abs(c[i]! - d[i]!));
      expect(diff).toBeLessThan(16); // encoder noise only
    },
    SLOW,
  );
});
