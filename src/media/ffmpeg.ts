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
