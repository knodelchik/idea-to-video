/**
 * npx tsx scripts/bench.ts --mock|--live [--models id,id] [--line "..."] [--yes]
 * Same keyframe, same verified voice, several video models, the same metrics (F09). Writes
 * docs/bench/<date>.md (live; <date>-mock.md for mock) and <same>-grid.mp4.
 * Live: prints the plan and the estimated total, and calls nothing unless --yes is given.
 * Exit 0 = report written; 1 = live plan printed without --yes, over budget, or the fixed inputs failed; 2 = bad arguments.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatPlan, pathOf, plan, plannedSpeechSeconds, selectModels, type BenchModel } from "../src/bench/registry.ts";
import { benchBase, benchMarkdown, writeGrid } from "../src/bench/report.ts";
import { benchModel, DEFAULT_BENCH_LINE, fixedInputs, type BenchRow, type BenchShared, type ModelProvider } from "../src/bench/run.ts";
import {
  Budget,
  GeminiJudge,
  GroqAsr,
  imageFromEnv,
  lipsyncFromEnv,
  maxCostFromEnv,
  MockAsr,
  MockImage,
  MockJudge,
  MockLipsync,
  MockTalking,
  MockTts,
  MockVideo,
  ttsFromEnv,
  withBudget,
  type Env,
  type Providers,
  type TalkingProvider,
  type VideoProvider,
} from "../src/providers/index.ts";

export const USAGE = 'usage: npx tsx scripts/bench.ts --mock|--live [--models id,id] [--line "..."] [--yes]';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BenchArgs {
  mode: "mock" | "live";
  models?: string[];
  line: string;
  yes: boolean;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  let mode: BenchArgs["mode"] | undefined;
  let models: string[] | undefined;
  let line: string | undefined;
  let yes = false;
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mock" || a === "--live") {
      const m = a.slice(2) as BenchArgs["mode"];
      if (mode && mode !== m) throw new Error("--mock and --live are mutually exclusive");
      mode = m;
    } else if (a === "--models") models = value(++i, a).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--line") line = value(++i, a);
    else if (a === "--yes") yes = true;
    else throw new Error(`unknown argument ${a}`);
  }
  // No default mode: a live bench is real money, so the caller must say which.
  if (!mode) throw new Error("say --mock or --live");
  const l = (line ?? DEFAULT_BENCH_LINE).trim();
  if (!l) throw new Error("--line is empty");
  return { mode, line: l, yes, ...(models ? { models } : {}) };
}

export interface BenchProviders {
  shared: BenchShared;
  model(m: BenchModel): ModelProvider;
}

export function mockBenchProviders(): BenchProviders {
  return {
    shared: { image: new MockImage(), tts: new MockTts(), asr: new MockAsr(), judge: new MockJudge(), lipsync: new MockLipsync() },
    model: (m) => (m.kind === "talking" ? new MockTalking() : new MockVideo({ nativeSpeech: m.nativeSpeech, durations: m.durations })),
  };
}

export function liveBenchProviders(env: Env): BenchProviders {
  return {
    shared: { image: imageFromEnv(env), tts: ttsFromEnv(env), asr: GroqAsr.fromEnv(env), judge: GeminiJudge.fromEnv(env), lipsync: lipsyncFromEnv(env) },
    model: (m) => m.live(env),
  };
}

const unused = (what: string) => () => {
  throw new Error(`bench: ${what} is not used by this bench row`);
};

/** The shared providers + this row's model, every paid call behind one Budget. */
function guarded(shared: BenchShared, budget: Budget, m?: BenchModel, provider?: ModelProvider): { shared: BenchShared; provider?: ModelProvider } {
  const stubVideo: VideoProvider = { name: "unused-video", capabilities: { nativeSpeech: false, durations: [4] }, animate: unused("video") };
  const stubTalking: TalkingProvider = { name: "unused-talking", talk: unused("talking") };
  const all: Providers = {
    ...shared,
    llm: { name: "unused-llm", generateJson: unused("llm") },
    video: m?.kind === "video" ? (provider as VideoProvider) : stubVideo,
    talking: m?.kind === "talking" ? (provider as TalkingProvider) : stubTalking,
  };
  const g = withBudget(all, budget);
  return {
    shared: { image: g.image, tts: g.tts, asr: g.asr, judge: g.judge, lipsync: g.lipsync },
    ...(m ? { provider: m.kind === "video" ? g.video : g.talking } : {}),
  };
}

export interface BenchDeps {
  env?: Env;
  /** Replaces the provider factory (tests). Called only after the live confirmation. */
  providers?: (mode: BenchArgs["mode"], env: Env) => BenchProviders;
  outDir?: string;
  cacheDir?: string;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(argv: string[], deps: BenchDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  let args: BenchArgs;
  let models: BenchModel[];
  try {
    args = parseBenchArgs(argv);
    models = selectModels(args.models);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const planned = plan(models, plannedSpeechSeconds(args.line), env);
  out(formatPlan(planned));
  let cap = Infinity;
  if (args.mode === "live") {
    // The gate before money: nothing is built or called until a human has seen the estimate and said yes.
    if (!args.yes) {
      out(`\nnot run: live mode needs --yes to spend ~$${planned.totalUsd.toFixed(2)}`);
      return 1;
    }
    cap = maxCostFromEnv(env);
    if (planned.totalUsd > cap) {
      err(`estimated ~$${planned.totalUsd.toFixed(2)} is over MAX_COST_USD=$${cap}; raise it or pick fewer --models`);
      return 1;
    }
  }

  const factory = deps.providers ?? ((mode, e) => (mode === "mock" ? mockBenchProviders() : liveBenchProviders(e)));
  let built: BenchProviders;
  try {
    built = factory(args.mode, env);
  } catch (e) {
    err(`providers: ${(e as Error).message}`);
    return 1;
  }
  const budget = new Budget(cap);
  const cacheDir = resolve(deps.cacheDir ?? join(ROOT, "runs", "bench"));
  await mkdir(cacheDir, { recursive: true });

  const sharedOnly = guarded(built.shared, budget).shared;
  let inputs;
  try {
    inputs = await fixedInputs(args.line, sharedOnly, cacheDir);
  } catch (e) {
    err(`fixed inputs failed (keyframe or verified voice): ${(e as Error).message}`);
    return 1;
  }
  err(`keyframe ${inputs.keyframe}\nvoice ${inputs.voice.path} (${inputs.voice.seconds.toFixed(2)} s)`);

  const rows: BenchRow[] = [];
  // Sequential on purpose: wall times stay comparable and only one paid generation is in flight.
  for (const [k, m] of models.entries()) {
    err(`[${k + 1}/${models.length}] ${m.id}`);
    let row: BenchRow;
    try {
      const g = guarded(built.shared, budget, m, built.model(m));
      row = await benchModel(m, g.provider!, inputs, args.line, g.shared, cacheDir, env);
    } catch (e) {
      // Building the provider failed (e.g. not configured): still a row, so the table shows why.
      row = { id: m.id, path: pathOf(m), provider: "—", seconds: 0, registryUsd: 0, reportedUsd: 0, wallMs: 0, issues: [], cached: false, error: (e as Error).message };
    }
    rows.push(row);
    err(`  ${row.error ? `FAILED: ${row.error}` : `ok (wer ${row.wer?.toFixed(2)}, judge ${row.clipScore ?? "—"})`}`);
  }

  const now = (deps.now ?? (() => new Date()))();
  const date = now.toISOString().slice(0, 10);
  const outDir = resolve(deps.outDir ?? join(ROOT, "docs", "bench"));
  await mkdir(outDir, { recursive: true });
  const base = benchBase(outDir, date, args.mode);
  const grid = await writeGrid(rows, `${base}-grid.mp4`);
  const md = benchMarkdown(
    { date, mode: args.mode, line: args.line, keyframe: inputs.keyframe, voice: inputs.voice, rows, estimateUsd: planned.totalUsd, ...(grid ? { grid } : {}) },
    ROOT,
  );
  await writeFile(`${base}.md`, md);
  out(`\n${md}`);
  out(`report: ${base}.md`);
  if (grid) out(`grid: ${grid}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
