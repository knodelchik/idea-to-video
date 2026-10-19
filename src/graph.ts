/**
 * The pipeline as a LangGraph state graph:
 *   script → cast → keyframes (sequential: s2 uses s1) → shot (one Send per shot, in parallel) → assemble → finalGate
 * Checkpointed to SQLite after every step (thread_id = runId), so a crashed run resumes where it stopped and
 * finished stages are never paid for twice. Transient provider errors are retried by the node retryPolicy; quality
 * failures are handled inside the nodes; anything else ends the run with ok:false and a readable error. The run
 * manifest is rewritten after every step, and once more at the end whatever happened.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { assemble } from "./nodes/assemble.ts";
import { finalGate } from "./nodes/final-gate.ts";
import { writeScript } from "./nodes/script.ts";
import {
  DEFAULT_CLIP_MIN,
  DEFAULT_KEYFRAME_MIN,
  judgedKeyframe,
  judgedTalkingShot,
  type JudgedShot,
  type QualitySettings,
} from "./nodes/quality.ts";
import { castCharacters } from "./nodes/visuals.ts";
import { firstPrompt, SCRIPT_SYSTEM, storyboardOf } from "./prompts/script.ts";
import {
  Budget,
  HttpError,
  isTransientHttp,
  withBudget,
  type Providers,
} from "./providers/index.ts";
import {
  RunManifest,
  SCRIPT_SECONDS,
  SHOT_SECONDS,
  type Attempt,
  type FinalVideo,
  type Script,
  type Shot,
  type ShotOutput,
  type SpokenText,
  type VerbatimResult,
} from "./schemas.ts";
import { extractQuotedLines } from "./verbatim.ts";

export type Mode = "mock" | "live";
type ShotId = Shot["id"];
interface KeyframeQuality {
  score?: number;
  needsReview: boolean;
}

const merge = <T>(a: Partial<Record<ShotId, T>>, b: Partial<Record<ShotId, T>>) => ({ ...a, ...b });
const last = <T>() => Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => undefined as T });

export const RunState = Annotation.Root({
  idea: Annotation<string>,
  mode: Annotation<Mode>,
  runId: Annotation<string>,
  createdAt: Annotation<string>,
  script: last<Script | undefined>(),
  /** Portrait file per character name (F11: one per character). */
  portraits: last<Record<string, string> | undefined>(),
  keyframes: Annotation<Partial<Record<ShotId, string>>>({ reducer: merge, default: () => ({}) }),
  /** Judge outcome of each kept keyframe (F07), carried into the shot output. */
  keyframeQuality: Annotation<Partial<Record<ShotId, KeyframeQuality>>>({ reducer: merge, default: () => ({}) }),
  /** Merged by shot id: parallel shot tasks each write their own key. */
  shots: Annotation<Partial<Record<ShotId, ShotOutput>>>({ reducer: merge, default: () => ({}) }),
  /** Concatenated: every node appends what it tried. */
  attempts: Annotation<Attempt[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  costUsd: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  assembled: last<string | undefined>(),
  final: last<FinalVideo | undefined>(),
  verbatim: last<VerbatimResult | undefined>(),
  spoken: last<SpokenText | undefined>(),
  ok: last<boolean | undefined>(),
  error: last<string | undefined>(),
});
export type RunStateValues = typeof RunState.State;
type Patch = typeof RunState.Update;
/** What a node body returns; the wrapper adds earlier failed attempts and the cost. */
type NodePatch = Omit<Patch, "attempts" | "costUsd"> & { attempts: Attempt[] };

/** What a Send hands to one shot task (a Send's payload *is* that task's input, not the whole state). */
interface ShotTask {
  runId: string;
  script: Script;
  shot: Shot;
  keyframe: string;
  portraits: Record<string, string>;
  keyframeQuality?: KeyframeQuality;
}

// --- errors ---

const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/**
 * Worth retrying unchanged: HTTP 429/5xx, network failures, timeouts. Walks `cause`, because nodes wrap provider
 * errors (ShotError → HttpError). Quality failures, policy rejections, budget stops and 4xx are not transient.
 */
export function isTransient(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof HttpError) return isTransientHttp(e);
    // A TypeError is only a network failure when fetch says so; otherwise it is a bug and must not loop.
    if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return true;
    const { name, code } = e as { name?: unknown; code?: unknown };
    if (name === "TimeoutError" || (typeof code === "string" && TRANSIENT_CODES.has(code))) return true;
  }
  return false;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run-level error text. Parallel tasks that fail together arrive as one "Multiple errors occurred during superstep"
 * error with an `errors` array; the human needs the individual messages, not the wrapper's.
 */
export function runError(e: unknown): string {
  const many = (e as { errors?: unknown } | null)?.errors;
  if (Array.isArray(many) && many.length) return [...new Set(many.map(errMsg))].join("; ");
  return errMsg(e);
}

/** The attempts an error carries (ShotError, VerbatimError, ScriptError), else one failed attempt describing it. */
function attemptsOf(e: unknown, stage: string, shotId?: ShotId): Attempt[] {
  const carried = (e as { attempts?: unknown } | null)?.attempts;
  if (Array.isArray(carried)) return carried as Attempt[];
  return [{ stage, ...(shotId ? { shotId } : {}), n: 1, provider: "pipeline", ok: false, reason: errMsg(e), costUsd: 0, ms: 0 }];
}

const sumCost = (as: Attempt[]): number => as.reduce((s, a) => s + a.costUsd, 0);

// --- graph ---

export interface RetrySettings {
  maxAttempts: number;
  initialInterval: number;
  backoffFactor: number;
  jitter: boolean;
}
export const DEFAULT_RETRY: RetrySettings = { maxAttempts: 3, initialInterval: 2000, backoffFactor: 2, jitter: true };

export interface PipelineDeps {
  /** Providers for a mode. Called once the mode is known (a resumed run takes it from its checkpoint). */
  providers: (mode: Mode) => Providers;
  /** Where `<runId>/` folders and `checkpoints.sqlite` live. */
  runsDir: string;
  /** MAX_COST_USD. */
  maxCostUsd: number;
  retry?: Partial<RetrySettings>;
  /** Progress lines for humans (stderr in the CLI). */
  log?: (line: string) => void;
  /** Called before every node runs; tests throw here to simulate a crash between stages. */
  beforeNode?: (node: string, shotId?: ShotId) => void | Promise<void>;
  /** Judge pass marks (KEYFRAME_MIN / CLIP_MIN, F07). Defaults 7 / 5. */
  quality?: Partial<QualitySettings>;
}

interface Ctx {
  providers?: Providers;
  /** Asked before an optional clip regeneration (F07). */
  budget?: Budget;
  /** Attempts of failed node runs, by task key: kept for the retry that follows, or for the manifest if none does. */
  failed: Map<string, Attempt[]>;
}

function buildGraph(deps: PipelineDeps, ctx: Ctx) {
  const retry = { ...DEFAULT_RETRY, ...deps.retry };
  const quality: QualitySettings = { keyframeMin: DEFAULT_KEYFRAME_MIN, clipMin: DEFAULT_CLIP_MIN, ...deps.quality };
  const p = (): Providers => {
    if (!ctx.providers) throw new Error("pipeline: providers not set");
    return ctx.providers;
  };
  const runDir = (runId: string) => join(deps.runsDir, runId);

  /**
   * Every node goes through here: failed attempts are remembered under the task key so a retry's patch (or the
   * final manifest) still shows them — LangGraph drops a failed task's output, but the money was spent.
   */
  const node =
    <I>(name: string, fn: (input: I) => Promise<NodePatch>, shotOf?: (input: I) => ShotId) =>
    async (input: I): Promise<Patch> => {
      const shotId = shotOf?.(input);
      const key = shotId ? `${name}:${shotId}` : name;
      try {
        await deps.beforeNode?.(name, shotId);
        const patch = await fn(input);
        const attempts = [...(ctx.failed.get(key) ?? []), ...patch.attempts];
        ctx.failed.delete(key);
        deps.log?.(`✓ ${key}`);
        return { ...patch, attempts, costUsd: sumCost(attempts) };
      } catch (e) {
        const list = ctx.failed.get(key) ?? [];
        list.push(...attemptsOf(e, name, shotId));
        if (isTransient(e)) {
          const n = list.filter((a) => a.stage === "retry").length + 1;
          const again = n < retry.maxAttempts;
          list.push({
            stage: "retry",
            ...(shotId ? { shotId } : {}),
            n,
            provider: "pipeline",
            ok: false,
            reason: `transient error in ${key} (try ${n}/${retry.maxAttempts}): ${errMsg(e)}; ${again ? "retrying with backoff" : "giving up"}`,
            costUsd: 0,
            ms: 0,
          });
          deps.log?.(`! ${key}: transient error, ${again ? "retrying" : "giving up"}: ${errMsg(e)}`);
        } else {
          deps.log?.(`✗ ${key}: ${errMsg(e)}`);
        }
        ctx.failed.set(key, list);
        throw e;
      }
    };

  const retryPolicy = {
    ...retry,
    maxInterval: 60_000,
    retryOn: isTransient,
    logWarning: false, // recorded as a "retry" attempt instead
  };

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`pipeline: ${what} missing from state`);
    return v;
  };

  return new StateGraph(RunState)
    .addNode(
      // Node names can't equal state keys in LangGraph, hence writeScript / drawKeyframes.
      "writeScript",
      node("writeScript", async (s: RunStateValues) => {
        const { script, attempts } = await writeScript(s.idea, { llm: p().llm, lipsyncMaxSeconds: p().lipsync.maxSeconds });
        return { script, attempts };
      }),
      { retryPolicy },
    )
    .addNode(
      "cast",
      node("cast", async (s: RunStateValues) => {
        const r = await castCharacters(need(s.script, "script"), { image: p().image, dir: runDir(s.runId) });
        return { portraits: r.portraits, attempts: r.attempts };
      }),
      { retryPolicy },
    )
    .addNode(
      "drawKeyframes",
      node("drawKeyframes", async (s: RunStateValues) => {
        const script = need(s.script, "script");
        const portraits = need(s.portraits, "portraits");
        const keyframes: Partial<Record<ShotId, string>> = {};
        const keyframeQuality: Partial<Record<ShotId, KeyframeQuality>> = {};
        const attempts: Attempt[] = [];
        let prev: string | undefined;
        // Sequential on purpose: each keyframe is a reference for the next (continuity of light, wardrobe, place).
        for (const shot of script.shots) {
          const r = await judgedKeyframe(shot, script, portraits, prev, {
            image: p().image,
            judge: p().judge,
            dir: runDir(s.runId),
            min: quality.keyframeMin,
          });
          keyframes[shot.id] = r.path;
          keyframeQuality[shot.id] = { needsReview: r.needsReview, ...(r.score !== undefined ? { score: r.score } : {}) };
          attempts.push(...r.attempts);
          prev = r.path;
        }
        return { keyframes, keyframeQuality, attempts };
      }),
      { retryPolicy },
    )
    .addNode(
      "shot",
      node(
        "shot",
        async (t: ShotTask) => {
          const pr = p();
          const r = await judgedTalkingShot(t.shot, t.keyframe, {
            script: t.script,
            video: pr.video,
            asr: pr.asr,
            tts: pr.tts,
            lipsync: pr.lipsync,
            judge: pr.judge,
            portrait: t.portraits,
            dir: runDir(t.runId),
            min: quality.clipMin,
            ...(ctx.budget ? { budget: ctx.budget } : {}),
          });
          return { shots: { [t.shot.id]: shotOutput(r, t.keyframeQuality) }, attempts: r.attempts };
        },
        (t) => t.shot.id,
      ),
      { retryPolicy },
    )
    .addNode(
      "assemble",
      node("assemble", async (s: RunStateValues) => {
        const script = need(s.script, "script");
        const shots = script.shots.map((shot) => ({ shot, out: need(s.shots[shot.id], `shot ${shot.id}`) }));
        const r = await assemble(shots, { dir: runDir(s.runId) });
        return { assembled: r.path, attempts: r.attempts };
      }),
      { retryPolicy },
    )
    .addNode(
      "finalGate",
      node("finalGate", async (s: RunStateValues) => {
        const r = await finalGate(need(s.assembled, "assembled video"), need(s.script, "script"), { asr: p().asr });
        return {
          final: r.final,
          verbatim: r.verbatim,
          spoken: r.spoken,
          ok: r.ok,
          ...(r.ok ? {} : { error: `final gate: ${r.problems.join("; ")}` }),
          attempts: r.attempts,
        };
      }),
      { retryPolicy },
    )
    .addEdge(START, "writeScript")
    .addEdge("writeScript", "cast")
    .addEdge("cast", "drawKeyframes")
    .addConditionalEdges(
      "drawKeyframes",
      (s: RunStateValues) => {
        const script = need(s.script, "script");
        return script.shots.map(
          (shot) =>
            new Send("shot", {
              runId: s.runId,
              script,
              shot,
              keyframe: need(s.keyframes[shot.id], `keyframe ${shot.id}`),
              portraits: need(s.portraits, "portraits"),
              ...(s.keyframeQuality?.[shot.id] ? { keyframeQuality: s.keyframeQuality[shot.id] } : {}),
            } satisfies ShotTask),
        );
      },
      ["shot"],
    )
    .addEdge("shot", "assemble")
    .addEdge("assemble", "finalGate")
    .addEdge("finalGate", END);
}

function shotOutput(r: JudgedShot, kf?: KeyframeQuality): ShotOutput {
  return {
    path: r.path,
    seconds: r.seconds,
    hasAudio: r.hasAudio,
    audio: r.via === "lipsync" ? "fallback" : r.via,
    ...(r.speechStart !== undefined ? { speechStart: r.speechStart } : {}),
    ...(r.speechEnd !== undefined ? { speechEnd: r.speechEnd } : {}),
    ...(r.verbatim ? { verbatim: r.verbatim } : {}),
    ...(kf?.score !== undefined ? { keyframeScore: kf.score } : {}),
    ...(r.clipScore !== undefined ? { clipScore: r.clipScore } : {}),
    // The shot needs a human if either its keyframe or its clip was kept without passing.
    needsReview: r.needsReview || (kf?.needsReview ?? false),
  };
}

// --- running ---

/** Sortable and unique enough per machine: 20261016-142233-a1b2c3. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export const manifestPath = (runsDir: string, runId: string): string => join(runsDir, runId, "manifest.json");

/** State (+ attempts of failed tasks the state never received) → the contract written to disk. */
export function toManifest(s: RunStateValues, extra: { attempts?: Attempt[]; error?: string } = {}): RunManifest {
  const attempts = [...(s.attempts ?? []), ...(extra.attempts ?? [])];
  const error = extra.error ?? s.error;
  return RunManifest.parse({
    runId: s.runId,
    idea: s.idea,
    mode: s.mode,
    createdAt: s.createdAt,
    ...(s.script ? { script: s.script } : {}),
    ...(s.shots && Object.keys(s.shots).length ? { shots: s.shots } : {}),
    attempts,
    costUsd: Number(sumCost(attempts).toFixed(6)),
    ...(s.final ? { final: s.final } : {}),
    ...(s.verbatim ? { verbatim: s.verbatim } : {}),
    ...(s.spoken ? { spoken: s.spoken } : {}),
    ok: error === undefined && s.ok === true,
    ...(error !== undefined ? { error } : {}),
  });
}

const TYPICAL_SHOT_SECONDS = 8;

/**
 * Rough cost of a typical run, printed before a live run: one shot per storyboard beat (F12, up to 4), else 2 shots;
 * 8 s each, or less when that would pass the 30 s total; one native take each, no fallback, no regeneration.
 */
export function estimateRunUsd(p: Providers, idea: string): number {
  // An idea with unreadable quotes is rejected by the script node for $0; the estimate must not crash first.
  const quoted = (() => {
    try {
      return extractQuotedLines(idea);
    } catch {
      return [];
    }
  })();
  const shots = storyboardOf(idea)?.beats.length ?? 2;
  const seconds = Math.max(SHOT_SECONDS.min, Math.min(TYPICAL_SHOT_SECONDS, Math.floor(SCRIPT_SECONDS.max / shots)));
  const llm = p.llm.estimateUsd?.({ system: SCRIPT_SYSTEM, prompt: firstPrompt(idea, quoted) }) ?? 0;
  const image = p.image.estimateUsd?.({ prompt: "", out: "" }) ?? 0;
  const video = p.video.estimateUsd?.({ image: "", prompt: "", seconds, out: "" }) ?? 0;
  const asr = p.asr.estimateUsd?.({ path: "" }) ?? 0;
  // Judge (F07): each keyframe (image + portrait ref) and each clip (3 frames + portrait), all passing first time.
  const judge = shots * ((p.judge.estimateUsd?.({ images: 2, rubric: "" }) ?? 0) + (p.judge.estimateUsd?.({ images: 4, rubric: "" }) ?? 0));
  // Images: one portrait plus a keyframe per shot. ASR: each spoken shot plus the final gate (at most every shot + 1).
  return llm + (1 + shots) * image + shots * video + (1 + shots) * asr + judge;
}

/** A manifest lists checkpointed attempts first, then the failed ones; the tail past the checkpoint is the latter. */
async function previousFailures(path: string, checkpointed: number): Promise<Attempt[]> {
  try {
    const prev = RunManifest.parse(JSON.parse(await readFile(path, "utf8")));
    return prev.attempts.slice(checkpointed);
  } catch {
    return []; // no (readable) manifest: nothing to carry, the checkpoint still has everything that finished
  }
}

export type RunRequest ={ idea: string; mode: Mode } | { resume: string };

export interface RunOutcome {
  manifest: RunManifest;
  manifestPath: string;
}

export async function runPipeline(req: RunRequest, deps: PipelineDeps): Promise<RunOutcome> {
  await mkdir(deps.runsDir, { recursive: true });
  const ctx: Ctx = { failed: new Map() };
  const saver = SqliteSaver.fromConnString(join(deps.runsDir, "checkpoints.sqlite"));
  try {
    const app = buildGraph(deps, ctx).compile({ checkpointer: saver });
    const runId = "resume" in req ? req.resume : newRunId();
    const config = { configurable: { thread_id: runId } };

    const path = manifestPath(deps.runsDir, runId);
    let input: Patch | null;
    let state: RunStateValues;
    /** Failed attempts of the crashed process: in its manifest but never in the checkpoint. */
    let carried: Attempt[] = [];
    if ("resume" in req) {
      const snap = await app.getState(config);
      state = snap.values as RunStateValues;
      if (!state.idea) throw new Error(`no checkpoint for run ${runId} in ${deps.runsDir}`);
      input = null;
      carried = await previousFailures(path, state.attempts?.length ?? 0);
      deps.log?.(`resuming ${runId} (${state.mode}); next: ${snap.next.join(", ") || "nothing (run finished)"}`);
    } else {
      state = {
        idea: req.idea,
        mode: req.mode,
        runId,
        createdAt: new Date().toISOString(),
      } as RunStateValues;
      input = state;
    }
    // Finished stages of a resumed run already spent their share of the cap.
    const budget = new Budget(deps.maxCostUsd, (state.costUsd ?? 0) + sumCost(carried));
    ctx.providers = withBudget(deps.providers(state.mode), budget);
    ctx.budget = budget;

    await mkdir(join(deps.runsDir, runId), { recursive: true });
    const write = (m: RunManifest) => writeFile(path, `${JSON.stringify(m, null, 2)}\n`);

    let error: string | undefined;
    try {
      const stream = await app.stream(input, { ...config, streamMode: "values" });
      for await (const values of stream) {
        state = values as RunStateValues;
        await write(toManifest(state, { attempts: carried }));
      }
    } catch (e) {
      error = runError(e);
    }
    // The checkpoint is the truth (it includes writes of tasks that finished alongside a failed one).
    state = (await app.getState(config)).values as RunStateValues;
    const leftover = [...carried, ...[...ctx.failed.values()].flat()];
    if (error === undefined && state.ok === undefined) error = "run ended before the final gate";
    const manifest = toManifest(state, { attempts: leftover, ...(error !== undefined ? { error } : {}) });
    await write(manifest);
    return { manifest, manifestPath: path };
  } finally {
    saver.db.close();
  }
}
