/**
 * Models the bench can compare (F09), with list prices so the plan and the table can say what a run costs before
 * and after it happens. Each entry is one row of the table and one bench path:
 * - `video` + `nativeSpeech` → i2v with the line in the prompt, no lip-sync ("native", measured, not production);
 * - `video` without it → silent i2v, then lip-sync of the verified voice;
 * - `talking` → keyframe + verified voice → clip.
 * Prices: fal model pages, via docs/research/video-models.md and the adapters' own constants.
 */
import {
  FAL_NANO_BANANA_USD,
  FAL_SEEDANCE_USD_PER_SECOND,
  KLING_AVATAR_USD_PER_SECOND,
  KLING_LIPSYNC_MAX_SECONDS,
  SEEDANCE_DURATIONS,
  klingAvatarFromEnv,
  klingLipsyncCost,
  seedanceFromEnv,
  type Env,
  type TalkingProvider,
  type VideoProvider,
} from "../providers/index.ts";
import { snapDuration } from "../nodes/visuals.ts";

export type BenchPath = "native" | "lipsync" | "talking";

interface Base {
  id: string;
  /** Where the price and shape came from, for the reader of the table. */
  endpoint: string;
  usdPerSecond: number;
}
export interface VideoEntry extends Base {
  kind: "video";
  /** Decides the path: native speech (no lip-sync) or silent i2v + lip-sync. */
  nativeSpeech: boolean;
  durations: number[];
  live(env: Env): VideoProvider;
}
export interface TalkingEntry extends Base {
  kind: "talking";
  live(env: Env): TalkingProvider;
}
export type BenchModel = VideoEntry | TalkingEntry;

const seedance = (tier: "standard" | "fast") => (env: Env) =>
  seedanceFromEnv({ ...env, SEEDANCE_TRANSPORT: "fal", SEEDANCE_TIER: tier });

export const BENCH_MODELS: readonly BenchModel[] = [
  {
    id: "seedance-2.0",
    kind: "video",
    nativeSpeech: true,
    endpoint: "bytedance/seedance-2.0/image-to-video",
    usdPerSecond: FAL_SEEDANCE_USD_PER_SECOND.standard,
    durations: SEEDANCE_DURATIONS,
    live: seedance("standard"),
  },
  {
    id: "seedance-2.0-fast",
    kind: "video",
    nativeSpeech: true,
    endpoint: "bytedance/seedance-2.0/fast/image-to-video",
    usdPerSecond: FAL_SEEDANCE_USD_PER_SECOND.fast,
    durations: SEEDANCE_DURATIONS,
    live: seedance("fast"),
  },
  {
    id: "seedance-2.0+lipsync",
    kind: "video",
    nativeSpeech: false,
    endpoint: "bytedance/seedance-2.0/image-to-video + LIPSYNC_PROVIDER",
    usdPerSecond: FAL_SEEDANCE_USD_PER_SECOND.standard,
    durations: SEEDANCE_DURATIONS,
    live: seedance("standard"),
  },
  {
    id: "kling-avatar-v2",
    kind: "talking",
    endpoint: "fal-ai/kling-video/ai-avatar/v2/standard",
    usdPerSecond: KLING_AVATAR_USD_PER_SECOND.standard,
    live: (env) => klingAvatarFromEnv(env, "standard"),
  },
  {
    id: "kling-avatar-v2-pro",
    kind: "talking",
    endpoint: "fal-ai/kling-video/ai-avatar/v2/pro",
    usdPerSecond: KLING_AVATAR_USD_PER_SECOND.pro,
    live: (env) => klingAvatarFromEnv(env, "pro"),
  },
];

export const pathOf = (m: BenchModel): BenchPath => (m.kind === "talking" ? "talking" : m.nativeSpeech ? "native" : "lipsync");

/** `--models a,b` → entries in the order given. Unknown or repeated ids fail loudly (a typo must not cost a run). */
export function selectModels(ids: string[] | undefined, all: readonly BenchModel[] = BENCH_MODELS): BenchModel[] {
  if (!ids) return [...all];
  const unknown = ids.filter((id) => !all.some((m) => m.id === id));
  if (unknown.length) throw new Error(`unknown model(s): ${unknown.join(", ")}; known: ${all.map((m) => m.id).join(", ")}`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`model listed twice: ${dup}`);
  if (ids.length === 0) throw new Error("--models is empty");
  return ids.map((id) => all.find((m) => m.id === id)!);
}

/** Lead-in before the words start in a generated clip, plus room after them, seconds. */
export const CLIP_MARGIN_SECONDS = 1;
/** Speaking rate for planning before any audio exists: ~2.5 words/s plus a tail (slow side, so costs round up). */
export const plannedSpeechSeconds = (line: string): number =>
  Number((line.trim().split(/\s+/).filter(Boolean).length / 2.5 + 0.5).toFixed(2));

/** Clip length a model is asked for, given the voice length. Talking models follow the audio. */
export function clipSeconds(m: BenchModel, voiceSeconds: number): number {
  if (m.kind === "talking") return voiceSeconds;
  return snapDuration(Math.max(voiceSeconds + CLIP_MARGIN_SECONDS, Math.min(...m.durations)), m.durations);
}

/** List-price cost of one row: the model's seconds, plus the lip-sync on the lipsync path (fal-kling unless command). */
export function modelCostUsd(m: BenchModel, voiceSeconds: number, env: Env = {}): number {
  const seconds = clipSeconds(m, voiceSeconds);
  // Talking models bill output seconds; round up so the estimate never undershoots.
  const base = m.usdPerSecond * (m.kind === "talking" ? Math.ceil(seconds) : seconds);
  const lipsync =
    pathOf(m) === "lipsync" && (env.LIPSYNC_PROVIDER || "fal-kling").toLowerCase() === "fal-kling"
      ? klingLipsyncCost(Math.min(seconds, KLING_LIPSYNC_MAX_SECONDS))
      : 0;
  return Number((base + lipsync).toFixed(4));
}

/**
 * Rough upper bounds for the calls around the models: the fixed inputs (keyframe ≤ 1 image, voice ≤ 3 TTS takes
 * + ASR) once, and ASR + a 4-image judge call per row. Small next to video, but a plan should not omit them.
 */
export const FIXED_INPUTS_USD = Number((FAL_NANO_BANANA_USD + 0.06).toFixed(4));
export const PER_ROW_OVERHEAD_USD = 0.02;

export interface PlanRow {
  model: BenchModel;
  path: BenchPath;
  seconds: number;
  costUsd: number;
}
export interface Plan {
  rows: PlanRow[];
  voiceSeconds: number;
  totalUsd: number;
}

export function plan(models: BenchModel[], voiceSeconds: number, env: Env = {}): Plan {
  const rows = models.map((model) => ({
    model,
    path: pathOf(model),
    seconds: clipSeconds(model, voiceSeconds),
    costUsd: modelCostUsd(model, voiceSeconds, env),
  }));
  const totalUsd = FIXED_INPUTS_USD + rows.reduce((s, r) => s + r.costUsd + PER_ROW_OVERHEAD_USD, 0);
  return { rows, voiceSeconds, totalUsd: Number(totalUsd.toFixed(4)) };
}

export function formatPlan(p: Plan): string {
  const lines = p.rows.map(
    (r, i) => `  ${i + 1}. ${r.model.id.padEnd(22)} ${r.path.padEnd(8)} ${String(r.seconds).padStart(5)} s  ~$${r.costUsd.toFixed(2)}  (${r.model.endpoint})`,
  );
  return [
    `planned models (voice ~${p.voiceSeconds} s):`,
    ...lines,
    `  + fixed inputs ~$${FIXED_INPUTS_USD.toFixed(2)}, ASR + judge ~$${PER_ROW_OVERHEAD_USD.toFixed(2)} per model`,
    `estimated total: ~$${p.totalUsd.toFixed(2)}`,
  ].join("\n");
}
