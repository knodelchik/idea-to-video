/**
 * The bench runner (F09): one keyframe and one verified voice, made once and cached, then every model through
 * its path with the same metrics. A model that fails becomes a row with its error, never a crash of the bench.
 * Every artifact is content-addressed (`once`), so re-running after a crash does not pay again for finished rows.
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { trimArgs } from "../media/args.ts";
import { extractFrames } from "../media/frames.ts";
import { probe, run } from "../media/ffmpeg.ts";
import { listen } from "../nodes/gate.ts";
import { CLIP_FRAMES, DEFAULT_CLIP_MIN, judge } from "../nodes/quality.ts";
import { verifiedVoice } from "../nodes/voice.ts";
import { clipRubric } from "../prompts/judge.ts";
import { portraitPrompt, talkingPrompt } from "../prompts/visuals.ts";
import type {
  AsrProvider,
  ImageProvider,
  JudgeProvider,
  LipsyncProvider,
  TalkingProvider,
  TtsProvider,
  VideoProvider,
} from "../providers/index.ts";
import type { Script, Shot } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { clipSeconds, modelCostUsd, pathOf, type BenchModel, type BenchPath } from "./registry.ts";

export const DEFAULT_BENCH_LINE = "I kept every letter you never sent.";
/** Bump on any change to the fixed inputs' prompts: it is part of every bench artifact key. */
export const BENCH_VERSION = "bench-v1";

/** The fixed scene every model gets. A Script so the production prompts and rubrics apply unchanged. */
export function benchScript(line: string): Script {
  return {
    promptVersion: BENCH_VERSION,
    title: "Bench",
    logline: "A woman says one line to the camera.",
    setting: "a dim kitchen at night, warm practical light",
    characters: [
      {
        name: "Mara",
        look: "a woman in her thirties with shoulder-length dark curly hair, a mustard knit sweater, small gold hoop earrings",
        voice: { gender: "female", age: "adult", tone: "low and warm" },
        voiceDescription: "low, warm female voice, mid-30s, neutral American accent, unhurried",
      },
    ],
    shots: [benchShot(line, 8)],
    quotedLines: [line],
  };
}

export function benchShot(line: string, seconds: number): Shot {
  return {
    id: "s1",
    camera: "close-up",
    visual: "Mara at the kitchen table, face large in frame, looking into the camera",
    motion: "slow push-in",
    emotion: "quiet resolve",
    line,
    seconds,
    ...(line.trim() ? { speaker: "Mara" } : {}),
    onScreen: ["Mara"],
  };
}

export interface BenchShared {
  image: ImageProvider;
  tts: TtsProvider;
  asr: AsrProvider;
  judge: JudgeProvider;
  lipsync: LipsyncProvider;
}

export interface FixedInputs {
  keyframe: string;
  voice: { path: string; seconds: number };
  costUsd: number;
}

/** Portrait close-up keyframe + verbatim-verified voice. Both cached by content, so every run reuses them. */
export async function fixedInputs(line: string, shared: BenchShared, dir: string): Promise<FixedInputs> {
  const script = benchScript(line);
  const prompt = portraitPrompt(script);
  const key = await contentKey(BENCH_VERSION, "keyframe", shared.image.name, prompt);
  const kf = await once(join(dir, `keyframe-${key}.png`), (tmp) => shared.image.generate({ prompt, out: tmp }));
  const voice = await verifiedVoice(line, script.characters[0]!, { tts: shared.tts, asr: shared.asr, dir, emotion: "quiet resolve" });
  const costUsd = (kf.result?.costUsd ?? 0) + voice.attempts.reduce((s, a) => s + a.costUsd, 0);
  return { keyframe: kf.path, voice: { path: voice.path, seconds: voice.seconds }, costUsd };
}

export interface BenchRow {
  id: string;
  path: BenchPath;
  provider: string;
  /** Clip length asked of the model (talking: the audio length). */
  seconds: number;
  /** List price from the registry. */
  registryUsd: number;
  /** What the providers reported (0 for mocks), ASR and judge included. */
  reportedUsd: number;
  wallMs: number;
  /** Word error rate of the clip's own audio against the line; 1 when the clip has no audio track. */
  wer?: number;
  heard?: string;
  clipScore?: number;
  issues: string[];
  output?: string;
  cached: boolean;
  error?: string;
}

export type ModelProvider = VideoProvider | TalkingProvider;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One model through its path, measured. Never throws: a failure is a row with `error`. */
export async function benchModel(
  m: BenchModel,
  provider: ModelProvider,
  inputs: FixedInputs,
  line: string,
  shared: BenchShared,
  dir: string,
  env: Record<string, string | undefined> = {},
): Promise<BenchRow> {
  const path = pathOf(m);
  const seconds = clipSeconds(m, inputs.voice.seconds);
  const row: BenchRow = {
    id: m.id,
    path,
    provider: path === "lipsync" ? `${provider.name}+${shared.lipsync.name}` : provider.name,
    seconds,
    registryUsd: modelCostUsd(m, inputs.voice.seconds, env),
    reportedUsd: 0,
    wallMs: 0,
    issues: [],
    cached: false,
  };
  const t0 = performance.now();
  try {
    const made = await produce(m, path, provider, inputs, line, seconds, shared, dir);
    row.output = made.path;
    row.cached = made.cached;
    row.reportedUsd += made.costUsd;
    row.wallMs = Math.round(performance.now() - t0);

    const { hasAudio } = await probe(made.path);
    if (hasAudio) {
      const heard = await listen(made.path, line, { asr: shared.asr });
      row.wer = heard.wer;
      row.heard = heard.transcript.text; // as heard, not normalised: easier for a human to read
      row.reportedUsd += heard.costUsd;
    } else {
      // No audio stream: nothing was said. Live ASR would throw on it, and it is a full miss, not an error.
      row.wer = 1;
      row.heard = "";
      row.issues.push("no audio track");
    }

    const script = benchScript(line);
    const frames = await extractFrames(made.path, CLIP_FRAMES, dir);
    const judged = await judge(
      "clip",
      { paths: frames, refs: [inputs.keyframe] },
      { judge: shared.judge, rubric: clipRubric(benchShot(line, 8), script), min: DEFAULT_CLIP_MIN, dir, shotId: "s1", n: 1, subject: made.path },
    );
    row.reportedUsd += judged.attempt.costUsd;
    if (judged.verdict) {
      row.clipScore = judged.verdict.score;
      row.issues.push(...judged.verdict.issues);
    } else row.issues.push(judged.attempt.reason ?? "judge failed");
  } catch (e) {
    row.wallMs ||= Math.round(performance.now() - t0);
    row.error = errMsg(e);
  }
  row.reportedUsd = Number(row.reportedUsd.toFixed(4));
  return row;
}

async function produce(
  m: BenchModel,
  path: BenchPath,
  provider: ModelProvider,
  inputs: FixedInputs,
  line: string,
  seconds: number,
  shared: BenchShared,
  dir: string,
): Promise<{ path: string; cached: boolean; costUsd: number }> {
  const script = benchScript(line);
  const image = { file: inputs.keyframe };
  if (path === "talking") {
    const talking = provider as TalkingProvider;
    const prompt = talkingPrompt(benchShot("", 8), script);
    const key = await contentKey(BENCH_VERSION, m.id, talking.name, prompt, image, { file: inputs.voice.path });
    const r = await once(join(dir, `clip-${m.id}-${key}.mp4`), (tmp) =>
      talking.talk({ image: inputs.keyframe, audio: inputs.voice.path, prompt, out: tmp }),
    );
    return { path: r.path, cached: r.cached, costUsd: r.result?.costUsd ?? 0 };
  }

  const video = provider as VideoProvider;
  const native = path === "native";
  // Native: the line is in the prompt and the model speaks it. Lipsync: a silent take; the voice is synced on after.
  const prompt = talkingPrompt(benchShot(native ? line : "", 8), script);
  const key = await contentKey(BENCH_VERSION, m.id, video.name, prompt, seconds, image);
  const clip = await once(join(dir, `i2v-${m.id}-${key}.mp4`), (tmp) =>
    video.animate({ image: inputs.keyframe, prompt, seconds, out: tmp, ...(native ? { line } : {}) }),
  );
  let costUsd = clip.result?.costUsd ?? 0;
  if (native) return { path: clip.path, cached: clip.cached, costUsd };

  // Over the lip-sync model's limit (Kling: 10 s) → cut the silent take after the speech would end.
  let base = clip.path;
  const measured = (await probe(base)).seconds;
  if (measured > shared.lipsync.maxSeconds) {
    const cut = shared.lipsync.maxSeconds;
    if (inputs.voice.seconds > cut) {
      throw new Error(`voice ${inputs.voice.seconds} s is longer than ${shared.lipsync.name} accepts (${cut} s)`);
    }
    const trimmed = await once(join(dir, `trim-${m.id}-${key}-${cut}.mp4`), (tmp) => run(trimArgs({ input: base, out: tmp, seconds: cut })));
    base = trimmed.path;
  }
  const syncKey = await contentKey(BENCH_VERSION, "lipsync", shared.lipsync.name, { file: base }, { file: inputs.voice.path });
  const synced = await once(join(dir, `clip-${m.id}-${syncKey}.mp4`), (tmp) =>
    shared.lipsync.sync({ video: base, audio: inputs.voice.path, out: tmp }),
  );
  costUsd += synced.result?.costUsd ?? 0;
  return { path: synced.path, cached: clip.cached && synced.cached, costUsd };
}
