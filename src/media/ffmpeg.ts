/** Thin wrappers around the ffmpeg / ffprobe binaries. Argument building lives in args.ts (pure, tested). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Runs ffmpeg non-interactively; overwrites outputs. Throws FfmpegError with stderr on failure. */
export async function run(args: readonly string[]): Promise<void> {
  const full = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args];
  try {
    await exec("ffmpeg", full, { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    throw new FfmpegError(`ffmpeg failed: ${stderr.trim().split("\n").slice(-3).join(" | ")}`, full, stderr);
  }
}

/** Runs ffmpeg at info level and returns stderr: for filters that report on stderr (loudnorm, volumedetect). */
export async function runCapture(args: readonly string[]): Promise<string> {
  const full = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-y", ...args];
  try {
    const { stderr } = await exec("ffmpeg", full, { maxBuffer: 16 * 1024 * 1024 });
    return stderr;
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    throw new FfmpegError(`ffmpeg failed: ${stderr.trim().split("\n").slice(-3).join(" | ")}`, full, stderr);
  }
}

export interface ProbeResult {
  seconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

interface FfprobeJson {
  streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  format?: { duration?: string };
}

export async function probe(path: string): Promise<ProbeResult> {
  const args = ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", path];
  let stdout: string;
  try {
    ({ stdout } = await exec("ffprobe", args));
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    throw new FfmpegError(`ffprobe failed on ${path}: ${stderr.trim()}`, args, stderr);
  }
  return parseProbe(JSON.parse(stdout) as FfprobeJson);
}

/** Pure part of probe(), split out so it can be tested without a binary. */
export function parseProbe(json: FfprobeJson): ProbeResult {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const seconds = Number(json.format?.duration ?? video?.duration ?? 0);
  return {
    seconds: Number.isFinite(seconds) ? seconds : 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: video !== undefined,
  };
}

export interface Span {
  start: number;
  end: number;
}

/** silencedetect's stderr → silent spans (an open span at the end runs to `seconds`). Pure, for tests. */
export function parseSilence(stderr: string, seconds: number): Span[] {
  const out: Span[] = [];
  let open: number | undefined;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === "start") open = t;
    else if (open !== undefined) {
      out.push({ start: open, end: t });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ start: open, end: seconds });
  return out;
}

/**
 * Spans of digital silence (below -60 dB for at least `minSeconds`): where nothing can have been said. Whisper is
 * known to "hear" phrases in silence ("Thank you for watching!"); words inside these spans are not speech.
 */
export async function silentSpans(path: string, seconds: number, minSeconds = 0.5): Promise<Span[]> {
  const stderr = await runCapture(["-i", path, "-vn", "-af", `silencedetect=noise=-60dB:d=${minSeconds}`, "-f", "null", "-"]);
  return parseSilence(stderr, seconds);
}
