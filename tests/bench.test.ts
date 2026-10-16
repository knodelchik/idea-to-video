import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, mockBenchProviders, parseBenchArgs, type BenchProviders } from "../scripts/bench.ts";
import { gridArgs, gridLayout } from "../src/media/args.ts";
import { probe } from "../src/media/ffmpeg.ts";
import {
  BENCH_MODELS,
  clipSeconds,
  FIXED_INPUTS_USD,
  modelCostUsd,
  PER_ROW_OVERHEAD_USD,
  plan,
  plannedSpeechSeconds,
  selectModels,
} from "../src/bench/registry.ts";
import { benchBase, benchMarkdown, gridCells } from "../src/bench/report.ts";
import type { BenchRow } from "../src/bench/run.ts";
import { FalKlingAvatar, klingAvatarFromEnv, MockAsr, MockVideo, NotConfiguredError, type FalLike } from "../src/providers/index.ts";

const byId = (id: string) => BENCH_MODELS.find((m) => m.id === id)!;
const NOW = () => new Date("2026-10-16T12:00:00Z");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "itv-bench-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const quiet = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
};

describe("arguments and model selection", () => {
  it("needs an explicit mode, and parses --models, --line, --yes", () => {
    expect(() => parseBenchArgs([])).toThrow(/--mock or --live/);
    expect(() => parseBenchArgs(["--mock", "--live"])).toThrow(/mutually exclusive/);
    expect(() => parseBenchArgs(["--mock", "--line"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["--mock", "--bogus"])).toThrow(/unknown argument/);
    expect(parseBenchArgs(["--live", "--models", "seedance-2.0, kling-avatar-v2", "--line", "Hi there.", "--yes"])).toEqual({
      mode: "live",
      models: ["seedance-2.0", "kling-avatar-v2"],
      line: "Hi there.",
      yes: true,
    });
    expect(parseBenchArgs(["--mock"]).yes).toBe(false);
  });

  it("selects models in the given order; unknown, repeated or empty lists fail", () => {
    expect(selectModels(undefined).map((m) => m.id)).toEqual(BENCH_MODELS.map((m) => m.id));
    expect(selectModels(["kling-avatar-v2", "seedance-2.0"]).map((m) => m.id)).toEqual(["kling-avatar-v2", "seedance-2.0"]);
    expect(() => selectModels(["veo-9"])).toThrow(/unknown model\(s\): veo-9/);
    expect(() => selectModels(["seedance-2.0", "seedance-2.0"])).toThrow(/twice/);
    expect(() => selectModels([])).toThrow(/empty/);
  });

  it("the registry covers all three paths", () => {
    const paths = new Set(BENCH_MODELS.map((m) => (m.kind === "talking" ? "talking" : m.nativeSpeech ? "native" : "lipsync")));
    expect([...paths].sort()).toEqual(["lipsync", "native", "talking"]);
  });
});

describe("cost plan (registry)", () => {
  it("video models snap voice + margin to an allowed duration; talking follows the audio", () => {
    expect(clipSeconds(byId("seedance-2.0"), 2.9)).toBe(4);
    expect(clipSeconds(byId("seedance-2.0"), 5.2)).toBe(7);
    expect(clipSeconds(byId("kling-avatar-v2"), 2.9)).toBe(2.9);
  });

  it("prices each row from list prices, lip-sync included on the lipsync path", () => {
    expect(modelCostUsd(byId("seedance-2.0"), 2.9)).toBeCloseTo(4 * 0.3034, 4);
    expect(modelCostUsd(byId("seedance-2.0-fast"), 2.9)).toBeCloseTo(4 * 0.2419, 4);
    // Kling lip-sync bills 5 s steps at $0.014/s.
    expect(modelCostUsd(byId("seedance-2.0+lipsync"), 2.9)).toBeCloseTo(4 * 0.3034 + 0.07, 4);
    expect(modelCostUsd(byId("seedance-2.0+lipsync"), 2.9, { LIPSYNC_PROVIDER: "command" })).toBeCloseTo(4 * 0.3034, 4);
    expect(modelCostUsd(byId("kling-avatar-v2"), 2.9)).toBeCloseTo(3 * 0.0562, 4);
    expect(modelCostUsd(byId("kling-avatar-v2-pro"), 2.9)).toBeCloseTo(3 * 0.115, 4);
  });

  it("total = fixed inputs + every row + per-row ASR/judge overhead", () => {
    const models = selectModels(["seedance-2.0", "kling-avatar-v2"]);
    const p = plan(models, 2.9);
    expect(p.totalUsd).toBeCloseTo(FIXED_INPUTS_USD + 4 * 0.3034 + 3 * 0.0562 + 2 * PER_ROW_OVERHEAD_USD, 4);
    expect(plannedSpeechSeconds("one two three four five")).toBe(2.5);
  });
});

describe("grid (xstack) args", () => {
  it("layout is near-square, filled in reading order", () => {
    expect(gridLayout(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridLayout(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridLayout(5)).toEqual({ cols: 3, rows: 2 });
    expect(() => gridLayout(0)).toThrow(RangeError);
  });

  it("positions tiles row by row and labels tile k with k boxes; silent; black fill", () => {
    const args = gridArgs({ inputs: ["a", "b", "c", "d", "e"], out: "g.mp4", seconds: 4.5 });
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("xstack=inputs=5:layout=0_0|360_0|720_0|0_640|360_640:fill=black[v]");
    const tile3 = fc.split(";")[2]!;
    expect(tile3.startsWith("[2:v:0]")).toBe(true);
    expect(tile3.match(/drawbox/g)).toHaveLength(3);
    expect(args).toContain("-an");
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "4.5"]);
    expect(args.at(-1)).toBe("g.mp4");
  });

  it("one input needs no xstack", () => {
    const fc = gridArgs({ inputs: ["a"], out: "g.mp4", seconds: 4 })[3]!;
    expect(fc).toContain("[v0]null[v]");
    expect(fc).not.toContain("xstack");
  });
});

describe("report", () => {
  const row = (over: Partial<BenchRow>): BenchRow => ({
    id: "m",
    path: "native",
    provider: "p",
    seconds: 4,
    registryUsd: 1.2,
    reportedUsd: 0,
    wallMs: 1500,
    wer: 0,
    heard: "hi",
    clipScore: 8,
    issues: [],
    output: "/x/clip.mp4",
    cached: false,
    ...over,
  });

  it("numbers grid cells over successful rows only, in table order", () => {
    const rows = [row({}), row({ error: "boom", output: undefined }), row({})];
    expect(gridCells(rows)).toEqual([1, undefined, 2]);
  });

  it("table has one row per model, an empty notes column, and escapes pipes", () => {
    const md = benchMarkdown(
      {
        date: "2026-10-16",
        mode: "mock",
        line: "Hi.",
        keyframe: "/r/kf.png",
        voice: { path: "/r/v.wav", seconds: 1.2 },
        rows: [row({ id: "a" }), row({ id: "b", error: "bad | thing", output: undefined, wer: undefined, clipScore: undefined })],
        estimateUsd: 2,
        grid: "/r/docs/bench/2026-10-16-mock-grid.mp4",
      },
      "/r",
    );
    const table = md.split("\n").filter((l) => l.startsWith("| "));
    expect(table[0]).toMatch(/\| # \| model \|.*\| WER \| judge \|.*\| notes \|$/);
    expect(table).toHaveLength(3);
    expect(table[1]).toMatch(/^\| 1 \| a \| native \|.*\| 0\.00 \| 8\/10 \|.*\| ok \|  \|$/);
    expect(table[2]).toContain("FAILED: bad \\| thing");
    expect(table[2]!.startsWith("| — | b |")).toBe(true);
    expect(md).toContain("Grid: docs/bench/2026-10-16-mock-grid.mp4 (1×1");
    expect(md).toContain("Keyframe: kf.png");
    // Outside the repo root: kept absolute rather than a ../../ chain.
    expect(table[1]).toContain("| /x/clip.mp4 |");
  });

  it("mock runs reuse one file per day; live runs never overwrite", () => {
    expect(benchBase("/d", "2026-10-16", "mock", () => true)).toBe("/d/2026-10-16-mock");
    expect(benchBase("/d", "2026-10-16", "live", () => false)).toBe("/d/2026-10-16");
    const taken = new Set(["/d/2026-10-16.md", "/d/2026-10-16-2.md"]);
    expect(benchBase("/d", "2026-10-16", "live", (p) => taken.has(p))).toBe("/d/2026-10-16-3");
  });
});

describe("live gate (acceptance 2)", () => {
  it("--live without --yes prints models and estimate, builds no provider, writes nothing", async () => {
    const io = quiet();
    let built = 0;
    const outDir = join(dir, "gate-out");
    const code = await main(["--live"], {
      env: {},
      providers: () => {
        built++;
        throw new Error("must not be called");
      },
      outDir,
      cacheDir: join(dir, "gate-cache"),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(built).toBe(0);
    const text = io.out.join("\n");
    for (const m of BENCH_MODELS) expect(text).toContain(m.id);
    expect(text).toMatch(/estimated total: ~\$\d+\.\d\d/);
    expect(text).toMatch(/needs --yes/);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(join(dir, "gate-cache"))).toBe(false);
  });

  it("--live --yes over MAX_COST_USD refuses before building providers", async () => {
    const io = quiet();
    let built = 0;
    const code = await main(["--live", "--yes"], {
      env: { MAX_COST_USD: "0.5" },
      providers: () => {
        built++;
        throw new Error("must not be called");
      },
      outDir: join(dir, "cap-out"),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(built).toBe(0);
    expect(io.err.join("\n")).toMatch(/over MAX_COST_USD=\$0.5/);
  });

  it("bad arguments exit 2", async () => {
    const io = quiet();
    expect(await main(["--mock", "--models", "nope"], { stdout: io.stdout, stderr: io.stderr })).toBe(2);
  });
});

describe("mock bench end to end (acceptance 1)", () => {
  it("writes the table and the grid; every path speaks the line verbatim", async () => {
    const io = quiet();
    const outDir = join(dir, "out");
    const code = await main(["--mock"], { env: {}, outDir, cacheDir: join(dir, "cache"), now: NOW, stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(0);
    const md = await readFile(join(outDir, "2026-10-16-mock.md"), "utf8");
    const rows = md.split("\n").filter((l) => /^\| \d \|/.test(l));
    expect(rows).toHaveLength(BENCH_MODELS.length);
    for (const [i, m] of BENCH_MODELS.entries()) {
      const r = rows[i]!;
      expect(r.startsWith(`| ${i + 1} | ${m.id} |`)).toBe(true);
      expect(r).toContain("| 0.00 | 8/10 |");
      expect(r).toContain('"I kept every letter you never sent."');
    }
    expect(rows[2]).toContain("| lipsync |");
    expect(rows[3]).toContain("| talking |");

    const grid = join(outDir, "2026-10-16-mock-grid.mp4");
    const p = await probe(grid);
    expect(p).toMatchObject({ width: 1080, height: 1280, hasVideo: true, hasAudio: false });
    expect(p.seconds).toBeGreaterThanOrEqual(3.9);
  }, 120_000);

  it("a failing model is a row, not a crash; ASR mishearing shows as WER", async () => {
    const io = quiet();
    const mocks = mockBenchProviders();
    // ASR call 0 verifies the voice; call 1 hears the first row's clip.
    const custom: BenchProviders = {
      shared: { ...mocks.shared, asr: new MockAsr({ faults: [{ call: 1, replace: { letter: "ladder" } }] }) },
      model: (m) => (m.id === "seedance-2.0-fast" ? new MockVideo({ faults: [{ call: 0, reject: "real person" }] }) : mocks.model(m)),
    };
    const outDir = join(dir, "out-fail");
    const code = await main(["--mock", "--models", "seedance-2.0,seedance-2.0-fast,kling-avatar-v2", "--line", "One letter for you."], {
      env: {},
      providers: () => custom,
      outDir,
      cacheDir: join(dir, "cache-fail"),
      now: NOW,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const md = await readFile(join(outDir, "2026-10-16-mock.md"), "utf8");
    const table = md.split("\n").filter((l) => /^\| (\d|—) \|/.test(l));
    expect(table).toHaveLength(3);
    expect(table[0]).toMatch(/^\| 1 \| seedance-2.0 \|.*\| 0\.25 \|/);
    expect(table[1]).toMatch(/^\| — \| seedance-2.0-fast \|.*FAILED: .*real person/);
    expect(table[2]).toMatch(/^\| 2 \| kling-avatar-v2 \|/);
    expect((await probe(join(outDir, "2026-10-16-mock-grid.mp4"))).width).toBe(720);
  }, 120_000);

  it("a live run (injected mock providers) writes <date>.md and never overwrites it", async () => {
    const outDir = join(dir, "live-out");
    const run = () =>
      main(["--live", "--yes", "--models", "kling-avatar-v2"], {
        env: {},
        providers: () => mockBenchProviders(),
        outDir,
        cacheDir: join(dir, "live-cache"),
        now: NOW,
        stdout: () => {},
        stderr: () => {},
      });
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect(existsSync(join(outDir, "2026-10-16.md"))).toBe(true);
    expect(existsSync(join(outDir, "2026-10-16-2.md"))).toBe(true);
    expect(existsSync(join(outDir, "2026-10-16-2-grid.mp4"))).toBe(true);
    // The second run reused the cached clip instead of generating again.
    expect(await readFile(join(outDir, "2026-10-16-2.md"), "utf8")).toContain("(cached)");
  }, 120_000);
});

describe("FalKlingAvatar (live talking adapter, fake fal)", () => {
  it("uploads image + audio, calls the tier endpoint, bills measured output seconds", async () => {
    const img = join(dir, "kf.bin");
    const wav = join(dir, "v.bin");
    await writeFile(img, "image-bytes");
    await writeFile(wav, "audio-bytes");
    const subscribed: { endpoint: string; input: Record<string, unknown> }[] = [];
    const fal: FalLike = {
      async subscribe(endpoint, { input }) {
        subscribed.push({ endpoint, input });
        return { data: { video: { url: "https://cdn/x.mp4" }, duration: 99 }, requestId: "r" };
      },
      storage: { upload: async (b: Blob) => `https://up/${(await b.text()).split("-")[0]}` },
    };
    const fetch = (async () => new Response("mp4-bytes")) as unknown as typeof globalThis.fetch;
    const t = new FalKlingAvatar({ fal, tier: "pro", fetch, probe: async () => ({ seconds: 3 }) });
    const r = await t.talk({ image: img, audio: wav, prompt: "p", out: join(dir, "talk.mp4") });
    expect(subscribed).toEqual([
      { endpoint: "fal-ai/kling-video/ai-avatar/v2/pro", input: { image_url: "https://up/image", audio_url: "https://up/audio", prompt: "p" } },
    ]);
    expect(r.costUsd).toBeCloseTo(3 * 0.115, 6);
    expect(await readFile(r.path, "utf8")).toBe("mp4-bytes");
    expect(t.name).toBe("fal-kling-avatar-v2-pro");
    expect(t.estimateUsd()).toBeCloseTo(10 * 0.115, 6);
  });

  it("without FAL_KEY is not configured", () => {
    expect(() => klingAvatarFromEnv({})).toThrow(NotConfiguredError);
  });
});
