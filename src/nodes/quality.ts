/**
 * Quality judge in the loop (F07). A VLM scores each keyframe and each finished clip. A low keyframe is redrawn with
 * the judge's issues appended (images are cheap); a low clip gets one regeneration only if the budget guard allows.
 * When nothing passes, the best attempt is kept and the shot is marked `needsReview`. Every verdict (score, issues,
 * cost), every judge failure and every skipped regeneration is an attempt in the manifest.
 *
 * A judge failure (error, or a reply that fails JudgeVerdict) is never a pass: the attempt counts as unscored.
 */
import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractFrames } from "../media/frames.ts";
import { clipRubric, JUDGE_PROMPT_VERSION, keyframeRubric } from "../prompts/judge.ts";
import { talkingPrompt } from "../prompts/visuals.ts";
import type { ImageProvider, JudgeProvider } from "../providers/index.ts";
import { JudgeVerdict, type Attempt, type Script, type Shot } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { VerbatimError } from "./gate.ts";
import { keyframeShot, ShotError, snapDuration, talkingShot, type TalkingShot, type TalkingShotOpts } from "./visuals.ts";

export const DEFAULT_KEYFRAME_MIN = 7;
export const DEFAULT_CLIP_MIN = 5;
/** Extra keyframes after the first when the judge scores it low. */
export const DEFAULT_KEYFRAME_EXTRA = 2;
/** Frames sampled from a clip for the judge. */
export const CLIP_FRAMES = 3;

export interface QualitySettings {
  keyframeMin: number;
  clipMin: number;
}

/** KEYFRAME_MIN / CLIP_MIN from env (1–10). Unset → defaults; anything else fails loudly. */
export function qualityFromEnv(env: Record<string, string | undefined>): QualitySettings {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error(`${name} must be a number 1–10, got "${raw}"`);
    return n;
  };
  return { keyframeMin: read("KEYFRAME_MIN", DEFAULT_KEYFRAME_MIN), clipMin: read("CLIP_MIN", DEFAULT_CLIP_MIN) };
}

const ms = (t0: number): number => Math.round(performance.now() - t0);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface Judged {
  /** Absent when the judge failed: unscored, which is not a pass. */
  verdict?: JudgeVerdict;
  pass: boolean;
  attempt: Attempt;
}

/**
 * One judge call, recorded. The verdict is cached next to the artifacts, keyed by the judged files, the rubric and the
 * prompt version, so a resumed run doesn't pay to judge the same file twice. Failed calls are not cached.
 */
export async function judge(
  what: "keyframe" | "clip",
  files: { paths: string[]; refs: string[] },
  ctx: {
    judge: JudgeProvider;
    rubric: string;
    min: number;
    dir: string;
    shotId: Shot["id"];
    n: number;
    /**
     * The judged artifact (a clip, when `paths` are its frames). Its content-addressed name joins the key: two
     * takes are separate judgements even if their sampled frames happen to be identical.
     */
    subject?: string;
  },
): Promise<Judged> {
  const { judge: j, rubric, min, dir, shotId, n } = ctx;
  const t0 = performance.now();
  const base = { stage: "judge", shotId, n, provider: j.name };
  try {
    const subject = ctx.subject ? basename(ctx.subject) : null;
    const files_ = [...files.paths, ...files.refs].map((file) => ({ file }));
    const key = await contentKey("judge", j.name, JUDGE_PROMPT_VERSION, what, rubric, subject, ...files_);
    const made = await once(join(dir, `judge-${what}-${shotId}-${key}.json`), async (tmp) => {
      const r =
        what === "keyframe"
          ? await j.judgeImage({ path: files.paths[0]!, rubric, refs: files.refs })
          : await j.judgeVideo({ frames: files.paths, rubric, refs: files.refs });
      await writeFile(tmp, JSON.stringify({ score: r.score, issues: r.issues }));
      return r;
    });
    // Re-parse even our own cache: a hand-edited or truncated file must not pass as a verdict.
    const verdict = JudgeVerdict.parse(JSON.parse(await readFile(made.path, "utf8")));
    const pass = verdict.score >= min;
    const notes = [
      `${what} score ${verdict.score}/10 ${pass ? ">=" : "<"} ${min}`,
      ...(verdict.issues.length ? [`issues: ${verdict.issues.join("; ")}`] : []),
      ...(made.result?.model ? [`model ${made.result.model}`] : []),
      ...(made.result?.notes ?? []),
      ...(made.cached ? ["reused cached verdict"] : []),
    ];
    return {
      verdict,
      pass,
      attempt: { ...base, ok: pass, score: verdict.score, reason: notes.join("; "), costUsd: made.result?.costUsd ?? 0, ms: ms(t0) },
    };
  } catch (e) {
    const paid = (e as { costUsd?: unknown } | null)?.costUsd;
    const costUsd = typeof paid === "number" && paid > 0 ? paid : 0;
    const reason = `judge failed on ${what} (counted as not passing): ${errMsg(e)}`;
    return { pass: false, attempt: { ...base, ok: false, reason, costUsd, ms: ms(t0) } };
  }
}

/** Index of the take to keep: the first that passed, else the highest score (earliest on ties), else the first. */
export function pickBest(takes: { pass: boolean; score?: number }[]): number {
  const passed = takes.findIndex((t) => t.pass);
  if (passed >= 0) return passed;
  let best = 0;
  takes.forEach((t, i) => {
    if ((t.score ?? -1) > (takes[best]!.score ?? -1)) best = i;
  });
  return best;
}

export interface JudgedKeyframe {
  path: string;
  score?: number;
  needsReview: boolean;
  attempts: Attempt[];
}

/**
 * Keyframe → judge → redraw with the issues appended while the score is under `min`, at most `maxExtra` times.
 * Judged against the portrait (same person) and the shot's own rubric.
 */
export async function judgedKeyframe(
  shot: Shot,
  script: Script,
  portrait: string,
  prev: string | undefined,
  opts: { image: ImageProvider; judge: JudgeProvider; dir: string; min?: number; maxExtra?: number },
): Promise<JudgedKeyframe> {
  const { image, judge: j, dir, min = DEFAULT_KEYFRAME_MIN, maxExtra = DEFAULT_KEYFRAME_EXTRA } = opts;
  const rubric = keyframeRubric(shot, script);
  const attempts: Attempt[] = [];
  const takes: { path: string; pass: boolean; score?: number }[] = [];
  let issues: string[] = [];
  for (let variant = 0; variant <= maxExtra; variant++) {
    const still = await keyframeShot(shot, script, portrait, prev, { image, dir, variant, issues });
    attempts.push(...still.attempts);
    const judged = await judge("keyframe", { paths: [still.path], refs: [portrait] }, { judge: j, rubric, min, dir, shotId: shot.id, n: variant + 1 });
    attempts.push(judged.attempt);
    takes.push({ path: still.path, pass: judged.pass, ...(judged.verdict ? { score: judged.verdict.score } : {}) });
    if (judged.pass) break;
    // An unscored take has no issues to pass on; the next take still differs by its variant.
    issues = judged.verdict?.issues ?? [];
  }
  const best = takes[pickBest(takes)]!;
  const needsReview = !best.pass;
  if (needsReview) {
    attempts.push({
      stage: "judge",
      shotId: shot.id,
      n: takes.length,
      provider: j.name,
      ok: false,
      reason: `no keyframe reached ${min}/10 in ${takes.length} tries; kept ${best.score === undefined ? "the first (none scored)" : `the best (score ${best.score})`}; needs review`,
      costUsd: 0,
      ms: 0,
      ...(best.score !== undefined ? { score: best.score } : {}),
    });
  }
  return { path: best.path, ...(best.score !== undefined ? { score: best.score } : {}), needsReview, attempts };
}

export interface JudgedShot extends TalkingShot {
  clipScore?: number;
  needsReview: boolean;
}

export interface JudgedShotOpts extends TalkingShotOpts {
  judge: JudgeProvider;
  /** Reference for "same person". */
  portrait: string;
  min?: number;
  /** The run's budget guard. Absent = no cap (tests, mocks). */
  budget?: { allows(estimateUsd: number): boolean };
}

/**
 * Worst case of one more take: every native video try, a lip-sync, and the judge. Asked of the guard as one sum,
 * so a regeneration that could not finish is never started.
 */
export function regenEstimateUsd(shot: Shot, keyframe: string, opts: JudgedShotOpts): number {
  const { video, lipsync, judge: j, script, maxNative = 2 } = opts;
  const seconds = snapDuration(shot.seconds, video.capabilities.durations);
  const take = video.estimateUsd?.({ image: keyframe, prompt: talkingPrompt(shot, script), seconds, out: "" }) ?? 0;
  const tries = video.capabilities.nativeSpeech ? maxNative : 1;
  const sync = shot.line.trim() ? (lipsync.estimateUsd?.({ video: "", audio: "", out: "" }) ?? 0) : 0;
  const judging = j.estimateUsd?.({ images: CLIP_FRAMES + 1, rubric: clipRubric(shot, script) }) ?? 0;
  return take * tries + sync + judging;
}

/**
 * talkingShot (verbatim-gated) → judge 3 frames against the portrait → under `min`, one more take if the budget
 * allows. A failing second take never loses the first: it was gated and paid for.
 */
export async function judgedTalkingShot(shot: Shot, keyframe: string, opts: JudgedShotOpts): Promise<JudgedShot> {
  const { judge: j, portrait, dir, min = DEFAULT_CLIP_MIN } = opts;
  const rubric = clipRubric(shot, opts.script);
  const attempts: Attempt[] = [];
  const judgeClip = async (r: TalkingShot, n: number) => {
    let frames: string[];
    try {
      frames = await extractFrames(r.path, CLIP_FRAMES, dir);
    } catch (e) {
      const attempt: Attempt = { stage: "judge", shotId: shot.id, n, provider: "ffmpeg", ok: false, reason: `judge failed on clip (counted as not passing): frame extraction: ${errMsg(e)}`, costUsd: 0, ms: 0 };
      return { pass: false, attempt } as Judged;
    }
    return judge("clip", { paths: frames, refs: [portrait] }, { judge: j, rubric, min, dir, shotId: shot.id, n, subject: r.path });
  };

  const first = await talkingShot(shot, keyframe, { ...opts, take: 1 });
  attempts.push(...first.attempts);
  const j1 = await judgeClip(first, 1);
  attempts.push(j1.attempt);
  const done = (r: TalkingShot, judged: Judged, needsReview: boolean): JudgedShot => ({
    ...r,
    attempts,
    needsReview,
    ...(judged.verdict ? { clipScore: judged.verdict.score } : {}),
  });
  if (j1.pass) return done(first, j1, false);

  const why = j1.verdict ? `clip score ${j1.verdict.score} < ${min}` : "clip judge failed";
  const estimate = regenEstimateUsd(shot, keyframe, opts);
  if (opts.budget && !opts.budget.allows(estimate)) {
    attempts.push({
      stage: "regen",
      shotId: shot.id,
      n: 1,
      provider: "budget",
      ok: false,
      reason: `${why}; regeneration skipped: budget guard refuses ~$${estimate.toFixed(4)} more (MAX_COST_USD); kept take 1; needs review`,
      costUsd: 0,
      ms: 0,
    });
    return done(first, j1, true);
  }
  attempts.push({
    stage: "regen",
    shotId: shot.id,
    n: 1,
    provider: "pipeline",
    ok: true,
    reason: `${why}; regenerating the shot once (~$${estimate.toFixed(4)} worst case)${j1.verdict?.issues.length ? " with the judge's issues in the prompt" : ""}`,
    costUsd: 0,
    ms: 0,
  });
  let second: TalkingShot;
  try {
    second = await talkingShot(shot, keyframe, { ...opts, take: 2, issues: j1.verdict?.issues ?? [] });
  } catch (e) {
    if (e instanceof ShotError || e instanceof VerbatimError) attempts.push(...e.attempts);
    attempts.push({
      stage: "regen",
      shotId: shot.id,
      n: 2,
      provider: "pipeline",
      ok: false,
      reason: `regenerated take failed (${errMsg(e)}); kept take 1; needs review`,
      costUsd: 0,
      ms: 0,
    });
    return done(first, j1, true);
  }
  attempts.push(...second.attempts);
  const j2 = await judgeClip(second, 2);
  attempts.push(j2.attempt);
  const takes = [
    { r: first, j: j1 },
    { r: second, j: j2 },
  ];
  const k = pickBest(takes.map((t) => ({ pass: t.j.pass, ...(t.j.verdict ? { score: t.j.verdict.score } : {}) })));
  const kept = takes[k]!;
  if (!kept.j.pass) {
    attempts.push({
      stage: "judge",
      shotId: shot.id,
      n: 2,
      provider: j.name,
      ok: false,
      reason: `no clip reached ${min}/10 in 2 takes; kept take ${k + 1}; needs review`,
      costUsd: 0,
      ms: 0,
      ...(kept.j.verdict ? { score: kept.j.verdict.score } : {}),
    });
  }
  return done(kept.r, kept.j, !kept.j.pass);
}
