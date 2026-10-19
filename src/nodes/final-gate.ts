/**
 * The last word on a run: the delivered file is probed (length, frame, audio) and listened to, end to end, against
 * every line of the script. Shot-level gates already passed; this catches anything assembly broke (a cut word, a
 * dropped track, a wrong order).
 */
import { performance } from "node:perf_hooks";
import { HEIGHT, WIDTH } from "../media/args.ts";
import { probe as ffprobe, silentSpans, type ProbeResult, type Span } from "../media/ffmpeg.ts";
import type { AsrProvider } from "../providers/index.ts";
import { SCRIPT_SECONDS, type Attempt, type FinalVideo, type Script, type SpokenText, type VerbatimResult } from "../schemas.ts";
import { compareWords, splitDelivery } from "../verbatim.ts";
import { describeIgnored, describeOps, listen, verbatimOf } from "./gate.ts";

export interface FinalGateResult {
  ok: boolean;
  final: FinalVideo;
  verbatim: VerbatimResult;
  spoken: SpokenText;
  /** Why `ok` is false, one readable item per failed check. Empty when ok. */
  problems: string[];
  attempts: Attempt[];
}

/** Every spoken line in shot order, delivery tags removed: what the whole video must say. */
export function expectedSpeech(script: Script): string {
  return script.shots
    .map((s) => splitDelivery(s.line).spoken)
    .filter((l) => l !== "")
    .join(" ");
}

/** Deterministic checks on the probed file (hard rule 4: never trust what a step says it made). */
export function probeProblems(p: ProbeResult): string[] {
  const out: string[] = [];
  if (p.seconds < SCRIPT_SECONDS.min || p.seconds > SCRIPT_SECONDS.max) {
    out.push(`duration ${p.seconds.toFixed(2)} s is outside ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} s`);
  }
  if (p.width !== WIDTH || p.height !== HEIGHT) out.push(`frame is ${p.width}×${p.height}, not ${WIDTH}×${HEIGHT}`);
  if (!p.hasAudio) out.push("no audio track");
  return out;
}

export async function finalGate(
  path: string,
  script: Script,
  opts: { asr: AsrProvider; probe?: (path: string) => Promise<ProbeResult>; silences?: (path: string, seconds: number) => Promise<Span[]> },
): Promise<FinalGateResult> {
  const t0 = performance.now();
  const media = await (opts.probe ?? ffprobe)(path);
  const problems = probeProblems(media);
  const expected = expectedSpeech(script);
  // The raw lines (tags kept) go to the gate, so a "[laughs]" still excuses heard laughter; it strips them itself.
  const lines = script.shots.map((s) => s.line).filter((l) => splitDelivery(l).spoken !== "").join(" ");
  // A file with no audio can't be listened to (live ASR extracts the audio stream and would throw).
  const silences = media.hasAudio ? await (opts.silences ?? silentSpans)(path, media.seconds) : [];
  const heard: Awaited<ReturnType<typeof listen>> = media.hasAudio
    ? await listen(path, lines, { asr: opts.asr, silences })
    : { ...compareWords(expected, ""), transcript: { text: "", words: [] }, costUsd: 0, speechStart: 0, speechEnd: 0 };
  if (!heard.pass) problems.push(`not verbatim (wer ${heard.wer.toFixed(2)}): ${describeOps(heard.ops) || "no speech heard"}`);
  const ok = problems.length === 0;
  const notes = [
    ...describeIgnored(heard),
    ...(heard.hallucinated ? [`ignored words ASR heard in digital silence (hallucination, nothing was said there): "${heard.hallucinated.slice(0, 120)}"`] : []),
  ];
  return {
    ok,
    final: { path, seconds: media.seconds, width: media.width, height: media.height, hasAudio: media.hasAudio },
    verbatim: verbatimOf(heard),
    spoken: { expected, heard: heard.transcript.text },
    problems,
    attempts: [
      {
        stage: "final",
        n: 1,
        provider: `ffprobe+${opts.asr.name}`,
        ok,
        ...(problems.length || notes.length ? { reason: [...problems, ...notes].join("; ") } : {}),
        costUsd: heard.costUsd,
        ms: Math.round(performance.now() - t0),
      },
    ],
  };
}
