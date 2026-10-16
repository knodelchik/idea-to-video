/**
 * Pure ffmpeg argument builders. No I/O here, so every flag that matters is unit-tested as data.
 * Outputs are always 1080×1920, 30 fps, yuv420p H.264 (what every phone and every platform accepts).
 */

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

/** Seconds → ffmpeg-friendly string with at most 3 decimals ("4", "2.333"). */
export const sec = (n: number): string => String(Number(n.toFixed(3)));

/** Frames needed for `seconds` at FPS. Rounded, so a clip is within half a frame of the request. */
export const frameCount = (seconds: number): number => Math.max(1, Math.round(seconds * FPS));

/** Scale-to-cover then centre-crop: never letterboxes, whatever the source aspect. */
const COVER = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`;

const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const AAC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

function assertSeconds(seconds: number, what = "seconds"): void {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`${what} must be > 0, got ${seconds}`);
}

export interface NormalizeClipOpts {
  input: string;
  out: string;
  seconds: number;
  /** Keep (and pad/cut) the input's first audio stream. Pass false for silent inputs, or ffmpeg errors. */
  audio: boolean;
}

/**
 * Any clip → exact 1080×1920 / 30 fps / yuv420p with exactly frameCount(seconds) frames.
 * tpad clones the last frame so a source that is slightly short still yields the full frame count.
 */
export function normalizeClipArgs({ input, out, seconds, audio }: NormalizeClipOpts): string[] {
  assertSeconds(seconds);
  const frames = frameCount(seconds);
  const exact = sec(frames / FPS);
  const vf = `${COVER},fps=${FPS},tpad=stop_mode=clone:stop=-1,format=yuv420p`;
  const audioArgs = audio ? ["-af", `apad,atrim=0:${exact}`, ...AAC] : ["-an"];
  return ["-i", input, "-vf", vf, "-frames:v", String(frames), ...H264, ...audioArgs, out];
}

export interface SegmentOpts {
  input: string;
  out: string;
  seconds: number;
  /** The input has an audio stream. false → a silent stereo track is generated so every segment can concat. */
  audio: boolean;
  /** Fade length at each end of the audio, seconds. Two adjacent segments' fades form a short crossfade at the cut. */
  fade: number;
}

/**
 * One shot of the final cut: normalised like normalizeClipArgs, audio always present (48 kHz stereo AAC), cut to
 * exactly frameCount(seconds) frames, with short audio fade-in/out so the joins don't click. The fades are on the
 * segment's own edges, so the cut keeps every segment's length and speech timing (an acrossfade would overlap
 * and shorten the audio, desyncing lips from the following shot).
 */
export function segmentArgs({ input, out, seconds, audio, fade }: SegmentOpts): string[] {
  assertSeconds(seconds);
  if (!Number.isFinite(fade) || fade < 0 || fade * 2 > seconds) throw new RangeError(`fade must be 0–${seconds / 2} s, got ${fade}`);
  const frames = frameCount(seconds);
  const exact = sec(frames / FPS);
  const vf = `${COVER},fps=${FPS},tpad=stop_mode=clone:stop=-1,format=yuv420p`;
  const fades = fade > 0 ? `,afade=t=in:st=0:d=${sec(fade)},afade=t=out:st=${sec(frames / FPS - fade)}:d=${sec(fade)}` : "";
  const af = `aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${exact}${fades}`;
  const silence = audio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
  return [
    "-i", input, ...silence,
    "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
    "-vf", vf, "-frames:v", String(frames), ...H264,
    "-af", af, ...AAC, "-t", exact,
    out,
  ];
}

export interface MuxOpts {
  video: string;
  audio: string;
  out: string;
  /** Video length in seconds; the audio is padded with silence or cut to exactly this. */
  seconds: number;
  /** Delay before the audio starts, seconds (>= 0). */
  offset?: number;
}

/** Video stream copied untouched; audio delayed by `offset`, padded/cut to the video length. */
export function muxArgs({ video, audio, out, seconds, offset = 0 }: MuxOpts): string[] {
  assertSeconds(seconds);
  if (!Number.isFinite(offset) || offset < 0) throw new RangeError(`offset must be >= 0, got ${offset}`);
  const ms = Math.round(offset * 1000);
  const af = `[1:a:0]adelay=${ms}:all=1,apad,atrim=0:${sec(seconds)}[a]`;
  return [
    "-i", video, "-i", audio,
    "-filter_complex", af,
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", ...AAC,
    "-t", sec(seconds),
    out,
  ];
}

export interface ConcatOpts {
  inputs: string[];
  out: string;
  /** All inputs have an audio stream (normalise first so they do). */
  audio: boolean;
}

/**
 * concat *filter* (re-encode), not the demuxer: safe even if inputs differ in timebase or codec params.
 * -shortest: AAC frame padding makes each segment's audio a few ms long; it adds up past the video end.
 */
export function concatArgs({ inputs, out, audio }: ConcatOpts): string[] {
  if (inputs.length === 0) throw new RangeError("concat needs at least one input");
  const n = inputs.length;
  const pads = inputs.map((_, i) => `[${i}:v:0]${audio ? `[${i}:a:0]` : ""}`).join("");
  const filter = `${pads}concat=n=${n}:v=1:a=${audio ? 1 : 0}[v]${audio ? "[a]" : ""}`;
  return [
    ...inputs.flatMap((p) => ["-i", p]),
    "-filter_complex", filter,
    "-map", "[v]", ...(audio ? ["-map", "[a]"] : []),
    ...H264, ...(audio ? [...AAC, "-shortest"] : ["-an"]),
    out,
  ];
}

/** What loudnorm's first pass prints (print_format=json); fed back for an exact, linear second pass. */
export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface LoudnormOpts {
  input: string;
  out: string;
  /** Input audio is silent: loudnorm would amplify noise / misbehave, so pass through with anull. */
  silent: boolean;
  /** First-pass measurement. Without it loudnorm runs one-pass dynamic, which can't lift quiet audio far. */
  measured?: LoudnessMeasure;
}

const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

/** First pass: measure only (stats go to stderr as JSON, nothing is written). */
export function loudnormMeasureArgs({ input }: { input: string }): string[] {
  return ["-i", input, "-vn", "-af", `${LOUDNORM}:print_format=json`, "-f", "null", "-"];
}

/** The JSON block loudnorm prints last on stderr. Throws if absent (e.g. the input had no audio). */
export function parseLoudnorm(stderr: string): LoudnessMeasure {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm: no measurement in ffmpeg output");
  const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
  for (const k of keys) {
    if (typeof j[k] !== "string" || !Number.isFinite(Number(j[k]))) throw new Error(`loudnorm: bad ${k} ${JSON.stringify(j[k])}`);
  }
  return Object.fromEntries(keys.map((k) => [k, j[k] as string])) as unknown as LoudnessMeasure;
}

/**
 * EBU R128 to −16 LUFS (the usual target for mobile/social). With `measured`, the documented two-pass linear
 * mode (exact gain, no pumping). Video copied; -shortest stops audio overhang.
 */
export function loudnormArgs({ input, out, silent, measured }: LoudnormOpts): string[] {
  const m = measured;
  const af = silent
    ? "anull"
    : m
      ? // loudnorm resamples to 192 kHz and its output can end a few ms early; resample back and pad so -shortest
        // cuts at the *video* end instead of shortening the film (an 8.0 s cut must not become 7.98 s).
        `${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
        `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000,apad`
      : LOUDNORM;
  return ["-i", input, "-af", af, "-c:v", "copy", ...AAC, "-shortest", out];
}

/**
 * First `seconds` of a clip, video only. Re-encoded (not `-c copy`) so the cut is frame-exact rather than at the
 * previous keyframe; audio dropped because this feeds lip-sync, which replaces it with the verified voice.
 */
export function trimArgs({ input, out, seconds }: { input: string; out: string; seconds: number }): string[] {
  assertSeconds(seconds);
  return ["-i", input, "-t", sec(seconds), "-map", "0:v:0", ...H264, "-an", out];
}

/** First audio stream → 16 kHz mono FLAC: what Whisper resamples to anyway, and small enough to upload. */
export function extractAudioArgs({ input, out }: { input: string; out: string }): string[] {
  return ["-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", out];
}

// --- Builders used by the mock providers (no drawtext/libass: the dev ffmpeg doesn't have them) ---

/** Solid-colour 1080×1920 PNG. `hex` is "rrggbb". */
export function colorImageArgs({ out, hex }: { out: string; hex: string }): string[] {
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new RangeError(`hex must be rrggbb, got ${hex}`);
  return ["-f", "lavfi", "-i", `color=c=0x${hex}:s=${WIDTH}x${HEIGHT}`, "-frames:v", "1", out];
}

/** Still image → silent mp4 of exactly frameCount(seconds) frames with a slow centred zoom-in. */
export function stillVideoArgs({ image, out, seconds }: { image: string; out: string; seconds: number }): string[] {
  assertSeconds(seconds);
  const frames = frameCount(seconds);
  const zoom =
    `zoompan=z='min(1+0.0006*on,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
    `:d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`;
  return ["-i", image, "-vf", `${COVER},${zoom},format=yuv420p`, "-frames:v", String(frames), ...H264, "-an", out];
}

/** Quiet sine tone wav of `seconds` — stands in for speech in mocks (non-silent, so loudnorm applies). */
export function toneArgs({ out, seconds, hz = 220 }: { out: string; seconds: number; hz?: number }): string[] {
  assertSeconds(seconds);
  return [
    "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=${sec(seconds)}`,
    "-af", "volume=0.2", "-ac", "1", "-c:a", "pcm_s16le", out,
  ];
}
