/**
 * pnpm make "<idea>" [--mock|--live] [--resume <runId>] [--json]
 * Default is --mock (free). Exit code 0 only when the final gate passed.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateRunUsd, REDO_STEPS, runPipeline, type Mode, type RedoStep, type RunOutcome } from "./graph.ts";
import { qualityFromEnv, type QualitySettings } from "./nodes/quality.ts";
import { createProviders, maxCostFromEnv, type Env, type FetchLike, type Providers } from "./providers/index.ts";
import { langfuseFromEnv } from "./obs/langfuse.ts";

export const USAGE = `usage: pnpm make "<idea>" [--mock|--live] [--resume <runId> [--redo <step>]] [--json] [--no-subtitles] [--run-id <id>] [-- "<idea>"]`;

/** Run ids name folders under the runs dir: word characters and dashes only (no path tricks). */
export const RUN_ID_RE = /^[\w-]+$/;

export interface CliArgs {
  idea?: string;
  mode?: Mode;
  resume?: string;
  /** With --resume: redo the run from this step (content-addressed artifacts are reused). */
  redo?: RedoStep;
  json: boolean;
  /** Present (false) only with --no-subtitles (F13); default is on. */
  subtitles?: false;
  /** --run-id: the caller (the web server, F15) picks the id so it can follow the run before it ends. */
  runId?: string;
}

/** SUBTITLES=0 / false / off turns burned-in subtitles off (F13); anything else, or unset, leaves them on. */
export function subtitlesFromEnv(env: Env): boolean {
  return !/^(?:0|false|off|no)$/i.test(env.SUBTITLES?.trim() ?? "");
}

/** Pure argv parser. Throws a readable message on anything it doesn't understand. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // "--" ends the flags: an idea that starts with "--" (typed into the web form) is never read as a flag.
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--json") out.json = true;
    else if (a === "--no-subtitles") out.subtitles = false;
    else if (a === "--mock" || a === "--live") {
      const mode = a.slice(2) as Mode;
      if (out.mode && out.mode !== mode) throw new Error("--mock and --live are mutually exclusive");
      out.mode = mode;
    } else if (a === "--resume") {
      const id = argv[++i];
      if (!id || id.startsWith("--")) throw new Error("--resume needs a run id");
      out.resume = id;
    } else if (a === "--run-id") {
      const id = argv[++i];
      if (!id || !RUN_ID_RE.test(id)) throw new Error("--run-id needs an id of letters, digits, _ and -");
      out.runId = id;
    } else if (a === "--redo") {
      const step = argv[++i];
      if (!step || !(REDO_STEPS as readonly string[]).includes(step)) throw new Error(`--redo needs a step: ${REDO_STEPS.join(", ")}`);
      out.redo = step as RedoStep;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`one idea, in quotes; got ${positional.length} arguments`);
  if (positional[0] !== undefined) out.idea = positional[0];
  if (!out.resume && !out.idea?.trim()) throw new Error("an idea is required");
  if (out.resume && out.idea) throw new Error("--resume continues a stored run; don't pass an idea with it");
  if (out.resume && out.mode) throw new Error("--resume uses the run's own mode; drop --mock/--live");
  if (out.redo && !out.resume) throw new Error("--redo needs --resume <runId>");
  if (out.runId && out.resume) throw new Error("--run-id names a new run; --resume already has one");
  return out;
}

export interface CliDeps {
  env?: Env;
  runsDir?: string;
  /** Replace providers (tests: counters, fault injection, live-priced fakes). */
  overrides?: Partial<Providers>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  retry?: { initialInterval?: number; maxAttempts?: number; jitter?: boolean };
  beforeNode?: (node: string, shotId?: string) => void | Promise<void>;
  /** Fetch for the Langfuse export (tests pass a fake). */
  fetch?: FetchLike;
}

/** Env values that look like credentials (…_KEY, …_SECRET, …_TOKEN): never written to a trace (F16). */
export function secretsFromEnv(env: Env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /(?:KEY|SECRET|TOKEN|PASSWORD)$/i.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v!);
}

/** The one-line summary `--json` prints (last line of stdout). */
export function summary(o: RunOutcome) {
  const m = o.manifest;
  return {
    ok: m.ok,
    runId: m.runId,
    finalPath: m.final?.path ?? null,
    seconds: m.final ? Number(m.final.seconds.toFixed(3)) : null,
    verbatim: m.verbatim ? { wer: m.verbatim.wer, expected: m.spoken?.expected ?? m.verbatim.expected, heard: m.spoken?.heard ?? m.verbatim.heard } : null,
    costUsd: m.costUsd,
    attempts: m.attempts.length,
    manifest: o.manifestPath,
    ...(m.error ? { error: m.error } : {}),
  };
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));

  let args: CliArgs;
  let maxCostUsd: number;
  let quality: QualitySettings;
  try {
    args = parseArgs(argv);
    maxCostUsd = maxCostFromEnv(env);
    quality = qualityFromEnv(env);
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const makeProviders = (mode: Mode): Providers => {
    const p = createProviders({ mode, env, overrides: deps.overrides ?? {} });
    if (mode === "live" && args.idea) {
      err(`live run: estimated ~$${estimateRunUsd(p, args.idea).toFixed(2)} for a typical run; MAX_COST_USD=$${maxCostUsd}`);
    }
    return p;
  };

  const langfuse = langfuseFromEnv(env);
  let outcome: RunOutcome;
  try {
    outcome = await runPipeline(args.resume ? { resume: args.resume, ...(args.redo ? { redo: args.redo } : {}) } : { idea: args.idea!, mode: args.mode ?? "mock", ...(args.runId ? { runId: args.runId } : {}) }, {
      providers: makeProviders,
      // RUNS_DIR lets the web server (F15) point its child runs at its own folder.
      runsDir: resolve(deps.runsDir ?? (env.RUNS_DIR?.trim() || "runs")),
      maxCostUsd,
      quality,
      subtitles: args.subtitles !== false && subtitlesFromEnv(env),
      secrets: secretsFromEnv(env),
      ...(langfuse ? { langfuse: { config: langfuse, ...(deps.fetch ? { fetch: deps.fetch } : {}) } } : {}),
      ...(deps.retry ? { retry: deps.retry } : {}),
      ...(deps.beforeNode ? { beforeNode: deps.beforeNode } : {}),
      log: err,
    });
  } catch (e) {
    // Only setup can land here (missing keys, unknown run id); node failures come back as ok:false.
    err(`error: ${(e as Error).message}`);
    if (args.json) out(JSON.stringify({ ok: false, error: (e as Error).message }));
    return 1;
  }

  const s = summary(outcome);
  if (args.json) out(JSON.stringify(s));
  else if (s.ok) out(`ok: ${s.finalPath} (${s.seconds} s, $${s.costUsd.toFixed(4)})\nmanifest: ${s.manifest}`);
  else out(`FAILED: ${s.error ?? "unknown"}\nmanifest: ${s.manifest}\nresume: pnpm make --resume ${s.runId}`);
  return s.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
