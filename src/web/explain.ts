/**
 * A failed run in plain words (F20), for the failure panel and `GET /api/runs/:id`. Pure: reads the manifest only —
 * the last failed attempts, `error`, and the recorded gate ops — and never calls a provider.
 */
import type { Attempt, RunManifest, VerbatimOp } from "../schemas.ts";
import type { RedoStep } from "../steps.ts";
import { diffFromOps, GATE_VERSION, parseOps, splitDelivery, wordDiff, type WordDiff } from "../verbatim.ts";

export type FailureKind = "verbatim" | "voiceTooLong" | "refused" | "budget" | "provider" | "judge" | "interrupted" | "unknown";

export interface FailureExplanation {
  kind: FailureKind;
  title: string;
  /** What happened, one sentence. */
  what: string;
  /** Why the agent stopped instead of shipping. */
  why: string;
  /** What Continue does, and what it may cost. */
  next: string;
  /** Graph step Continue redoes from; null = nothing to redo from, Continue resumes the checkpoint as it is. */
  step: RedoStep | null;
  shotId?: string;
  /** The line that had to be said, and what ASR heard (raw when recorded, else the gate's normalised words). */
  expected?: string;
  heard?: string;
  diff?: WordDiff;
  /** Continue makes new native takes of the failing shot(s) (`--fresh-takes`). */
  freshTakes: boolean;
  /** What Continue is expected to spend, USD. */
  estimateUsd: number;
  /** The take of the failing shot that was not shipped (a file in the run folder). */
  bestTake?: string;
  /** Shots that passed and will be reused. */
  finished: { shotId: string; path: string }[];
  /** The raw error, always kept. */
  error?: string;
}

/** Attempt stage (or node name) → the graph step it belongs to. */
const STEP_OF: Record<string, RedoStep> = {
  script: "writeScript",
  continuity: "writeScript",
  writeScript: "writeScript",
  portrait: "cast",
  cast: "cast",
  keyframe: "drawKeyframes",
  drawKeyframes: "drawKeyframes",
  video: "shot",
  voice: "shot",
  voiceover: "shot",
  lipsync: "shot",
  listen: "shot",
  fallback: "shot",
  trim: "shot",
  regen: "shot",
  shot: "shot",
  assemble: "assemble",
  subtitles: "burnSubtitles",
  burnSubtitles: "burnSubtitles",
  final: "finalGate",
  finalGate: "finalGate",
};

export function stepOf(a: Attempt): RedoStep | null {
  if (a.stage === "judge") return /^keyframe/.test(a.reason ?? "") ? "drawKeyframes" : "shot";
  if (a.stage === "retry") return STEP_OF[/transient error in (\w+)/.exec(a.reason ?? "")?.[1] ?? ""] ?? null;
  return STEP_OF[a.stage] ?? null;
}

const GATE_STAGES = new Set(["video", "voice", "voiceover", "lipsync", "final"]);
const opsOf = (a: Attempt): VerbatimOp[] => (GATE_STAGES.has(a.stage) ? parseOps(a.reason ?? "") : []);

/**
 * The failed attempt the run ended on. A shot error names its shot; a final-gate error the final check. Otherwise the
 * last failed attempt, unless a later attempt of the same stage passed (that failure was recovered from).
 */
function failingAttempt(m: RunManifest): Attempt | undefined {
  const fresh = m.attempts.filter((a) => !a.carried);
  const failed = (xs: Attempt[]) => xs.filter((a) => !a.ok);
  const shot = /(?:^|: )shot (s\d)\b/.exec(m.error ?? "")?.[1];
  if (shot) return failed(fresh).filter((a) => a.shotId === shot).at(-1);
  if (/^final gate/.test(m.error ?? "")) return failed(fresh).filter((a) => a.stage === "final").at(-1);
  const i = fresh.findLastIndex((a) => !a.ok);
  if (i < 0) return undefined;
  const a = fresh[i]!;
  return fresh.slice(i + 1).some((b) => b.ok && b.stage === a.stage && b.shotId === a.shotId) ? undefined : a;
}

function kindOf(error: string, a: Attempt | undefined): FailureKind {
  const reason = a?.reason ?? "";
  if (/\bbudget\b|MAX_COST_USD/i.test(error)) return "budget";
  if (/content policy/i.test(error)) return "refused";
  if (/longer than the [\d.]+ s clip|accepts at most [\d.]+ s of video/.test(error)) return "voiceTooLong";
  if (/not verbatim/.test(error)) return "verbatim";
  // Before any guess from the last failed attempt: a run cut off right after a refused take did not fail on that take
  // (the agent was still retrying), so calling it a verbatim refusal would misstate it and make Continue buy new takes.
  if (/interrupted by|crashed:|process ended/i.test(error)) return "interrupted";
  if (a && /^(?:voiceover|trim)$/.test(a.stage) && /speech ends at/.test(reason)) return "voiceTooLong";
  if (a && opsOf(a).length > 0) return "verbatim";
  if (a?.stage === "retry" || /transient|timed? ?out|\b(?:429|5\d\d)\b|ECONN|fetch failed|unavailable|video error|lip-sync error|asr error|HTTP/i.test(error)) return "provider";
  if (/judge|score \d+\/10/i.test(error)) return "judge";
  return "unknown";
}

const q = (w: string | undefined) => `"${w ?? ""}"`;

/** 'it heard "for" where the line says "four", and an extra "dollars"'. */
export function opsInWords(ops: VerbatimOp[]): string {
  const parts = ops.map((o) =>
    o.type === "sub" ? `${q(o.heard)} where the line says ${q(o.expected)}` : o.type === "del" ? `nothing for ${q(o.expected)}` : `an extra ${q(o.heard)}`,
  );
  if (parts.length === 0) return "no speech at all";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Video price per second from what this run really paid (video takes of known length); the fallback when it paid for
 * none. Mock runs pay nothing, so their estimate is $0.
 */
export function videoUsdPerSecond(m: RunManifest, fallback: number): number {
  if (m.mode === "mock") return 0;
  const seconds = (id?: string) => Math.ceil(m.script?.shots.find((s) => s.id === id)?.seconds ?? 0);
  const paid = m.attempts.filter((a) => a.stage === "video" && a.costUsd > 0 && seconds(a.shotId) > 0);
  if (!paid.length) return fallback;
  return paid.reduce((s, a) => s + a.costUsd, 0) / paid.reduce((s, a) => s + seconds(a.shotId), 0);
}

/** Speech recognition, voice and judge calls around a take: cents, not dollars. */
export const SMALL_CALLS_USD = 0.01;

export interface ExplainOpts {
  /** Live video $/s when the run has no paid take to learn it from (default: fal Seedance fast at 720p). */
  fallbackVideoUsdPerSecond?: number;
}

export function explainFailure(m: RunManifest, opts: ExplainOpts = {}): FailureExplanation {
  const error = m.error ?? "the run ended without a final video";
  const a = failingAttempt(m);
  const kind = kindOf(error, a);
  const shotId = a?.shotId ?? /(?:^|: )shot (s\d)\b/.exec(error)?.[1];
  // An interrupted run resumes its checkpoint as it is: nothing failed, so nothing is redone.
  const step: RedoStep | null = kind === "interrupted" ? null : a ? stepOf(a) : /(?:^|: )shot s\d\b/.test(error) ? "shot" : /^final gate/.test(error) ? "finalGate" : null;
  const shot = m.script?.shots.find((s) => s.id === shotId);
  const where = shotId ? `Shot ${shotId}` : "The finished video";
  const finished = Object.entries(m.shots ?? {})
    .filter(([id, out]) => id !== shotId && out?.path)
    .map(([id, out]) => ({ shotId: id, path: out!.path }));
  const takes = m.attempts.filter((x) => x.stage === "video" && x.shotId === shotId && x.path && !x.carried);
  const bestTake = (takes.filter((x) => x.ok).at(-1) ?? takes.sort((x, y) => opsOf(x).length - opsOf(y).length)[0])?.path;

  // Native takes of this shot the gate refused, and whether the current rules did it (then they'd refuse them again).
  const nativeMisses = m.attempts.filter((x) => x.stage === "video" && x.shotId === shotId && !x.ok && opsOf(x).length > 0);
  const freshTakes = kind === "verbatim" && step === "shot" && nativeMisses.length > 0 && nativeMisses.every((x) => x.gateVersion === GATE_VERSION);
  const perSecond = videoUsdPerSecond(m, opts.fallbackVideoUsdPerSecond ?? 0.2419);
  const failingSeconds = m.script?.shots.filter((s) => !m.shots?.[s.id]).reduce((n, s) => n + Math.ceil(s.seconds), 0) ?? 0;
  const small = m.mode === "mock" ? 0 : SMALL_CALLS_USD;
  // New video is bought for fresh takes, for a shot that never got a clip (a provider error), and (worst case) when
  // the redo starts before the shots. Re-gating saved takes buys none: only the small calls.
  const madeClip = m.attempts.some((x) => x.stage === "video" && x.shotId === shotId && (x.ok || x.path !== undefined || opsOf(x).length > 0));
  const needsVideo = freshTakes || (step === "shot" && !madeClip) || (step !== null && ["writeScript", "cast", "drawKeyframes"].includes(step));
  const estimateUsd = Number(((needsVideo ? failingSeconds * perSecond : 0) + small).toFixed(2));
  const cost = `~$${estimateUsd.toFixed(2)}`;
  const reuse = "shots that passed are reused for $0";
  const retry = `Continue retries from ${step ?? "where it stopped"}; everything finished is reused.`;

  const base = { kind, step, ...(shotId ? { shotId } : {}), freshTakes, estimateUsd, finished, error, ...(bestTake ? { bestTake } : {}) };

  if (kind === "verbatim") {
    const ops = a ? opsOf(a) : [];
    const line = a?.stage === "final" || !shot ? (m.script?.shots.map((s) => splitDelivery(s.line).spoken).filter(Boolean).join(" ") ?? "") : splitDelivery(shot.line).spoken;
    const diff = a?.heard !== undefined ? wordDiff(line, a.heard) : ops.length ? diffFromOps(line, ops) : undefined;
    const heard = a?.heard ?? diff?.heard.map((w) => w.word).join(" ");
    const tried = nativeMisses.length ? ` ${nativeMisses.length} native take${nativeMisses.length > 1 ? "s were" : " was"} checked and none said the line exactly.` : "";
    return {
      ...base,
      title: `${where} was not shipped: the words did not match the line`,
      what: `${where}: the spoken line was not word-for-word, so the agent refused to ship it.`,
      why: `Speech recognition heard ${opsInWords(ops)}.${tried}`,
      next: freshTakes
        ? `Continue makes new takes of this shot (${cost}); ${reuse}.`
        : a?.stage === "final"
          ? `Continue runs the final check again on the saved video (${cost}); with unchanged rules it fails the same way.`
          : `The word check has changed since these takes were judged, so Continue re-runs it on the saved takes (${cost}); ${reuse}.`,
      expected: line,
      ...(heard !== undefined ? { heard } : {}),
      ...(diff ? { diff } : {}),
    };
  }
  if (kind === "voiceTooLong") {
    const n = /([\d.]+) s of speech\) is longer than the ([\d.]+) s clip/.exec(error) ?? /speech ends at ([\d.]+) s, after the ([\d.]+) s clip/.exec(a?.reason ?? "");
    return {
      ...base,
      title: `${where} was not shipped: the voice is longer than the clip`,
      what: `${where}: the checked voice runs past the end of its clip, so the agent refused to cut words off.`,
      why: n
        ? `The verified voice needs ${n[1]} s but the clip is ${n[2]} s long; speeding it up that much would sound wrong, and cutting it would drop words.`
        : `The verified voice does not fit the clip: ${a?.reason ?? error}`,
      next: `Continue re-runs this shot on the saved takes with the current code (${cost}); it helps when the code has changed since (a longer clip, a faster voice). ${reuse[0]!.toUpperCase()}${reuse.slice(1)}.`,
    };
  }
  const texts: Record<Exclude<FailureKind, "verbatim" | "voiceTooLong">, { title: string; what: string; why: string }> = {
    refused: {
      title: `${where} was refused by the video model`,
      what: `${where}: every way of sending the pictures to the video model was refused by its content policy (it took a face for a real person).`,
      why: "The agent never sends the same refused input again without a change; there was no rung left to try.",
    },
    budget: {
      title: "The run stopped at its spending cap",
      what: `The run reached MAX_COST_USD before it finished${shotId ? ` (at shot ${shotId})` : ""}.`,
      why: "A call that would pass the cap is never started, so the run stopped there instead.",
    },
    provider: {
      title: "A model provider kept failing",
      what: `A provider call${shotId ? ` for shot ${shotId}` : ""} kept failing (an error, a timeout or an overload) after the retries.`,
      why: "Retrying without end would spend time and money for nothing, so the run stopped.",
    },
    judge: {
      title: `${where} was below the quality bar`,
      what: `The quality judge scored ${shotId ? `shot ${shotId}` : "the picture"} below the bar after the allowed retries.`,
      why: "The agent does not ship a take its judge rejected without a human looking at it.",
    },
    interrupted: {
      title: "The run stopped before it finished",
      what: "The run's process ended (a restart or a stop) before the video was finished.",
      why: "Nothing was wrong with the video so far; the work was cut off.",
    },
    unknown: {
      title: "The run failed",
      what: "The run stopped with an error that has no plain explanation here.",
      why: "The raw error is below.",
    },
  };
  return { ...base, ...texts[kind], next: kind === "interrupted" && step === null ? "Continue resumes the run where it stopped; everything finished is reused." : retry };
}
