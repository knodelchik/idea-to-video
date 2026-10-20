/**
 * Starting a pipeline run from the web (F15): the real CLI in a child process, argument array, no shell. Tests
 * inject their own `StartRun` that writes manifests over time instead.
 */
import { spawn } from "node:child_process";
import type { WebConfig } from "./config.ts";

export type Mode = "mock" | "live";

export interface RunSpec {
  runId: string;
  idea: string;
  mode: Mode;
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface RunResult {
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  /** Tail of stdout + stderr, for the server log and a run that died before writing a manifest. */
  output: string;
}

export interface RunHandle {
  done: Promise<RunResult>;
  /** The child's pid (F19): a `running` manifest whose process is gone is shown as interrupted. */
  pid?: number;
}

export type StartRun = (spec: RunSpec) => RunHandle;

/** The web server's own secrets are no business of the child. */
const SERVER_ONLY = new Set(["ACCESS_CODE", "SESSION_SECRET"]);

/**
 * `node --import tsx src/cli.ts --<mode> --json --run-id <id> -- <idea>`. The idea is one argv entry after "--", so
 * quotes, `$()` or a leading "--live" in it are just text. The id is ours, so the page can follow the run at once.
 */
export function runSpec(cfg: WebConfig, idea: string, mode: Mode, runId: string, baseEnv: Record<string, string | undefined> = process.env): RunSpec {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (!SERVER_ONLY.has(k)) env[k] = v;
  env.MAX_COST_USD = String(cfg.maxCostUsd);
  env.RUNS_DIR = cfg.runsDir;
  return {
    runId,
    idea,
    mode,
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", `--${mode}`, "--json", "--run-id", runId, "--", idea],
    env,
    cwd: cfg.root,
  };
}

/**
 * F20 Continue: `cli.ts --resume <id> [--redo <step>] [--fresh-takes] --json`, same env as a new run (so the server's
 * MAX_COST_USD caps the new spend; a redo does not count what earlier passes paid). No step = plain resume.
 */
export function continueSpec(
  cfg: WebConfig,
  run: { runId: string; idea: string; mode: Mode },
  step: string | null,
  freshTakes: boolean,
  baseEnv: Record<string, string | undefined> = process.env,
): RunSpec {
  const spec = runSpec(cfg, run.idea, run.mode, run.runId, baseEnv);
  const redo = step ? ["--redo", step, ...(freshTakes ? ["--fresh-takes"] : [])] : [];
  return { ...spec, args: ["--import", "tsx", "src/cli.ts", "--resume", run.runId, ...redo, "--json"] };
}

const TAIL = 8 * 1024;

export const spawnRunner: StartRun = (spec) => {
  let output = "";
  const keep = (b: Buffer) => {
    output = (output + b.toString("utf8")).slice(-TAIL);
  };
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<RunResult>((resolveDone) => {
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => resolveDone({ code: null, output: `${output}\n${e.message}` }));
    child.on("close", (code) => resolveDone({ code, output }));
  });
  return { done, ...(child.pid !== undefined ? { pid: child.pid } : {}) };
};

/** Is that process still there? EPERM = it exists but is not ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
