/**
 * Sample N frames evenly from a clip, for the clip judge (F07). The arg builders are pure and tested. Frames are
 * content-addressed by the clip's bytes, so a resumed run reuses them.
 */
import { join } from "node:path";
import { contentKey, once } from "../util/cache.ts";
import { sec } from "./args.ts";
import { probe, run } from "./ffmpeg.ts";

/**
 * Centres of N equal slices of the clip: (i + 0.5) · seconds / n. Never t=0 (often a still keyframe) or the very
 * end (a seek there can return no frame).
 */
export function frameTimes(seconds: number, n: number): number[] {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`seconds must be > 0, got ${seconds}`);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be an integer >= 1, got ${n}`);
  return Array.from({ length: n }, (_, i) => Number((((i + 0.5) * seconds) / n).toFixed(3)));
}

/** One JPEG frame at `at` seconds. `-ss` before `-i`: a fast seek that is frame-accurate when re-encoding. */
export function frameArgs({ input, at, out }: { input: string; at: number; out: string }): string[] {
  if (!Number.isFinite(at) || at < 0) throw new RangeError(`at must be >= 0, got ${at}`);
  return ["-ss", sec(at), "-i", input, "-frames:v", "1", "-q:v", "3", out];
}

/** Extracts `n` evenly spaced frames of `input` into `dir`; returns their paths in time order. */
export async function extractFrames(input: string, n: number, dir: string): Promise<string[]> {
  const { seconds } = await probe(input);
  const key = await contentKey("frames", { file: input });
  const paths: string[] = [];
  for (const [i, at] of frameTimes(seconds, n).entries()) {
    const made = await once(join(dir, `frame-${key}-${n}-${i}.jpg`), (tmp) => run(frameArgs({ input, at, out: tmp })));
    paths.push(made.path);
  }
  return paths;
}
