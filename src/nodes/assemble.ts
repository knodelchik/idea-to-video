/**
 * Assembly: each shot normalised to 1080×1920/30 fps and cut to its length (never before its last word + a tail),
 * every shot keeps its own verified audio, joined with short audio fades, loudness-normalised to −16 LUFS.
 * Every intermediate is content-addressed, so a resumed run re-uses them; `final.mp4` is a copy of the last one.
 */
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { concatArgs, FPS, frameCount, loudnormArgs, loudnormMeasureArgs, parseLoudnorm, segmentArgs } from "../media/args.ts";
import { run, runCapture } from "../media/ffmpeg.ts";
import type { Attempt, Shot, ShotOutput } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { linkSources } from "../util/sidecar.ts";

/** Silence kept after a shot's last word, so the line never ends on a hard cut. */
export const SPEECH_TAIL = 0.4;
/** Audio fade at each segment edge; two of them make the crossfade at a join. */
export const JOIN_FADE = 0.05;
/** Audio fade-out over the last 200 ms of every segment (F11): the official fix for Seedance's end-of-clip click. */
export const END_FADE = 0.2;
export const FINAL_NAME = "final.mp4";

/**
 * How long a shot runs in the cut: the script's length, stretched to speechEnd + tail if the words run later,
 * but never past the clip that exists (models deliver whole seconds ≥ the script's, lip-sync may have trimmed).
 */
export function cutSeconds(scriptSeconds: number, clipSeconds: number, speechEnd?: number): number {
  const want = Math.max(scriptSeconds, (speechEnd ?? 0) + SPEECH_TAIL);
  return Number(Math.min(clipSeconds, want).toFixed(3));
}

export interface AssembleShot {
  shot: Shot;
  out: ShotOutput;
}

export interface Assembled {
  /** final.mp4 (a copy of `cut`). */
  path: string;
  /** The content-addressed loudnormed cut: what later steps (subtitles, F13) read, since final.mp4 gets replaced. */
  cut: string;
  attempts: Attempt[];
}

export interface PlannedSegment {
  shotId: Shot["id"];
  /** Where the segment starts on the final timeline, seconds. */
  offset: number;
  /** Its exact length (a whole number of frames). */
  seconds: number;
  /** The length asked of ffmpeg (cutSeconds). */
  cut: number;
}

/** Where each shot starts and how long it runs in the cut (each segment is exactly frameCount(seconds) frames). */
export function segmentPlan(shots: AssembleShot[]): PlannedSegment[] {
  let offset = 0;
  return shots.map(({ shot, out }) => {
    const cut = cutSeconds(shot.seconds, out.seconds, out.speechEnd);
    const seconds = frameCount(cut) / FPS;
    const at = { shotId: shot.id, offset: Number(offset.toFixed(3)), seconds, cut };
    offset += seconds;
    return at;
  });
}

/**
 * First word to last word on the final timeline, from each shot's own gate (speechStart/End + its offset).
 * Used to spread subtitles when the final transcript has no word timestamps (F13). Undefined: nothing spoken.
 */
export function speechWindow(shots: AssembleShot[]): { start: number; end: number } | undefined {
  const plan = segmentPlan(shots);
  const spans: { s: number; e: number }[] = [];
  shots.forEach(({ out }, i) => {
    if (out.speechStart === undefined || out.speechEnd === undefined) return;
    const seg = plan[i]!;
    spans.push({ s: seg.offset + out.speechStart, e: seg.offset + Math.min(out.speechEnd, seg.seconds) });
  });
  if (spans.length === 0) return undefined;
  return { start: Number(spans[0]!.s.toFixed(3)), end: Number(spans.at(-1)!.e.toFixed(3)) };
}

export async function assemble(shots: AssembleShot[], { dir }: { dir: string }): Promise<Assembled> {
  if (shots.length === 0) throw new Error("assemble: no shots");
  const t0 = performance.now();
  let reused = 0;

  const segments: { path: string; seconds: number }[] = [];
  const plan = segmentPlan(shots);
  for (const [i, { shot, out }] of shots.entries()) {
    const seconds = plan[i]!.cut;
    const key = await contentKey("segment", { file: out.path }, seconds, out.hasAudio, JOIN_FADE, END_FADE);
    const made = await once(join(dir, `segment-${shot.id}-${key}.mp4`), async (tmp) => {
      await run(segmentArgs({ input: out.path, out: tmp, seconds, audio: out.hasAudio, fade: JOIN_FADE, endFade: END_FADE }));
      await linkSources(tmp, [{ source: out.path, until: seconds }]);
    });
    if (made.cached) reused++;
    // The segment is exactly frameCount(seconds) frames; that is where the next one starts.
    segments.push({ path: made.path, seconds: frameCount(seconds) / FPS });
  }

  const concatKey = await contentKey("concat", ...segments.map((s) => ({ file: s.path })));
  const joined = await once(join(dir, `concat-${concatKey}.mp4`), async (tmp) => {
    await run(concatArgs({ inputs: segments.map((s) => s.path), out: tmp, audio: true }));
    let offset = 0;
    const parts = segments.map((s) => {
      const part = { source: s.path, offset: Number(offset.toFixed(3)) };
      offset += s.seconds;
      return part;
    });
    await linkSources(tmp, parts);
  });

  const loudKey = await contentKey("loudnorm-2pass-v2", { file: joined.path });
  const loud = await once(join(dir, `loudnorm-${loudKey}.mp4`), async (tmp) => {
    const measured = parseLoudnorm(await runCapture(loudnormMeasureArgs({ input: joined.path })));
    await run(loudnormArgs({ input: joined.path, out: tmp, silent: false, measured }));
    await linkSources(tmp, [{ source: joined.path }]);
  });

  // final.mp4 is the stable name humans and the CLI look for; replace it whole so it never mixes two runs' bytes.
  const final = join(dir, FINAL_NAME);
  await rm(final, { force: true });
  await copyFile(loud.path, final);
  await linkSources(final, [{ source: loud.path }]);

  const cached = reused === segments.length && joined.cached && loud.cached;
  return {
    path: final,
    cut: loud.path,
    attempts: [
      {
        stage: "assemble",
        n: 1,
        provider: "ffmpeg",
        ok: true,
        reason:
          `${segments.length} shot(s): ${segments.map((s) => `${s.seconds.toFixed(2)} s`).join(" + ")}, ` +
          `${JOIN_FADE} s edge fades + ${END_FADE} s end fade-out, loudnorm −16 LUFS${cached ? "; reused cached cut" : ""}`,
        costUsd: 0,
        ms: Math.round(performance.now() - t0),
      },
    ],
  };
}
