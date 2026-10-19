/**
 * Burned-in subtitles (F13). The text is the *expected* line (exact by construction: never ASR text, never the video
 * model's own captions), split into 2–6 word chunks; the timing comes from ASR word timestamps of the assembled cut,
 * aligned with the verbatim gate's own normalisation (so "1987" lines up with "nineteen eighty-seven"). Each cue is a
 * transparent PNG card overlaid for its window. Every artifact is content-addressed.
 */
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { overlayCuesArgs } from "../media/args.ts";
import { probe as ffprobe, run } from "../media/ffmpeg.ts";
import { CARD_VERSION, fitsCard, renderCard } from "../media/subtitle-card.ts";
import type { AsrProvider } from "../providers/index.ts";
import type { Attempt, Script, SubtitleCue, Subtitles, TranscriptWord } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { linkSources } from "../util/sidecar.ts";
import { alignPieces, splitDelivery, wordCount } from "../verbatim.ts";
import { FINAL_NAME } from "./assemble.ts";

export const CUE_WORDS = { min: 2, max: 6 } as const;
/** Kept on screen after the cue's last word ends. */
export const CUE_TAIL = 0.15;
/** Shortest time a cue stays up (unless the next cue starts sooner: no overlap wins). */
export const CUE_MIN = 0.8;
/** A gap shorter than this between two cues is closed (no flicker). */
export const CUE_GAP_CLOSE = 0.25;

const oneSpace = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A word that ends a phrase: trailing , . ; : ! ? … or a dash, optionally followed by a closing quote/bracket. */
const ENDS_PHRASE = /[,.;:!?…—–]["'”’)\]]*$/;
/** Abbreviations whose full stop is not a phrase end. */
const ABBREV = /^(?:dr|mr|mrs|ms|st|mt|jr|sr|vs)\.$/i;
/** Tokens that must stay with the word before them ("3:15 a.m.", "50 %"). */
const GLUED = /^(?:a\.?m\.?|p\.?m\.?|%)["'”’),.;:!?…]*$/i;

const fits = (ws: string[]): boolean => ws.length <= CUE_WORDS.max && fitsCard(ws.join(" "));

/**
 * Split one run of words into the fewest near-even pieces that each fit (≤ 6 words, ≤ 2 lines of 32 chars),
 * never breaking before a glued token. Boundaries snap to the nearest allowed position.
 */
function splitRun(ws: string[]): string[][] {
  if (fits(ws)) return [ws];
  const allowed = (i: number) => i > 0 && i < ws.length && !GLUED.test(ws[i]!);
  for (let n = Math.max(2, Math.ceil(ws.length / CUE_WORDS.max)); n <= ws.length; n++) {
    const cuts: number[] = [];
    for (let k = 1; k < n; k++) {
      const ideal = Math.round((k * ws.length) / n);
      let best: number | undefined;
      for (let d = 0; d < ws.length && best === undefined; d++) {
        for (const c of [ideal - d, ideal + d]) if (best === undefined && allowed(c) && c > (cuts.at(-1) ?? 0)) best = c;
      }
      if (best !== undefined) cuts.push(best);
    }
    const bounds = [0, ...cuts, ws.length];
    const pieces = bounds.slice(1).map((end, i) => ws.slice(bounds[i]!, end));
    if (pieces.every((p) => p.length > 0 && fits(p))) return pieces;
  }
  return ws.map((w) => [w]); // unreachable in practice: one word per cue
}

/** Two adjacent pieces as one run → the same words in pieces that all fit and have ≥ 2 words, or undefined. */
function rejoin(ws: string[]): string[][] | undefined {
  const parts = splitRun(ws);
  return parts.every((p) => p.length >= CUE_WORDS.min && fits(p)) ? parts : undefined;
}

/**
 * One spoken line → cue texts. Breaks at punctuation first, then splits long phrases evenly; a one-word piece
 * joins a neighbour when the result still fits. Never inside a word; the pieces joined by spaces are the line.
 */
export function chunkLine(spoken: string): string[] {
  const ws = oneSpace(spoken).split(" ").filter(Boolean);
  const phrases: string[][] = [];
  let cur: string[] = [];
  ws.forEach((w, i) => {
    cur.push(w);
    const next = ws[i + 1];
    if (ENDS_PHRASE.test(w) && !ABBREV.test(w) && (next === undefined || !GLUED.test(next))) {
      phrases.push(cur);
      cur = [];
    }
  });
  if (cur.length) phrases.push(cur);
  const pieces = phrases.flatMap(splitRun);
  // Merge one-word pieces into a neighbour (next first: "No. I kept it." reads as one beat). When the neighbour is
  // already full ("Yes," + a 6-word piece), re-split the two together so no cue is left with one word.
  for (let i = 0; i < pieces.length; i++) {
    if (pieces.length < 2 || pieces[i]!.length >= CUE_WORDS.min) continue;
    const lone = pieces[i]!;
    const next = pieces[i + 1];
    const prev = pieces[i - 1];
    const withNext = next && rejoin([...lone, ...next]);
    const withPrev = !withNext && prev ? rejoin([...prev, ...lone]) : undefined;
    const at = withNext ? i : i - 1;
    const merged = withNext ?? withPrev;
    if (!merged) continue; // e.g. a word too long for any card: nothing it can join still fits
    pieces.splice(at, 2, ...merged);
    i = at - 1;
  }
  return pieces.map((p) => p.join(" "));
}

/** Every spoken line of the script, delivery tags removed, in shot order (what the final gate expects). */
export function cueTexts(script: Script): string[] {
  return script.shots.flatMap((s) => chunkLine(splitDelivery(s.line).spoken));
}

/** Code checks the cues, not the model: joined they must be the expected text exactly (whitespace-normalised). */
export function assertCuesMatch(texts: string[], expected: string): void {
  const got = oneSpace(texts.join(" "));
  const want = oneSpace(expected);
  if (got !== want) throw new Error(`subtitles: cue texts ${JSON.stringify(got)} do not equal the line ${JSON.stringify(want)}`);
}

const r3 = (n: number): number => Number(n.toFixed(3));

/** Shortest window a cue can have (degenerate input only). */
const CUE_SLIVER = 0.05;

/**
 * Min duration, then no overlap and no tiny gaps; ends clamped to the video. Starts are never moved, except in the
 * degenerate case of a cue starting less than a sliver after the previous one (cues on one instant): that start is
 * pushed to previous start + sliver, so both cues keep a valid window and neither runs into the other.
 */
function settle(raw: { start: number; end: number; text: string }[], duration: number): SubtitleCue[] {
  const cues = raw.map((c) => ({ ...c, end: Math.max(c.end, c.start + CUE_MIN) }));
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    if (next && next.start < c.start + CUE_SLIVER) next.start = c.start + CUE_SLIVER;
    if (next && (c.end > next.start || next.start - c.end < CUE_GAP_CLOSE)) c.end = next.start;
    c.end = Math.min(c.end, duration);
    // Clamped to nothing by the video's end: keep a sliver, never past the next cue's start.
    if (c.end <= c.start) c.end = next ? Math.min(c.start + CUE_SLIVER, next.start) : c.start + CUE_SLIVER;
  });
  return cues.map((c) => ({ start: r3(c.start), end: r3(c.end), text: c.text }));
}

export interface TimedCues {
  cues: SubtitleCue[];
  timing: "asr" | "spread";
  /** Why the cues were spread instead of timed by words. */
  note?: string;
}

/** Cues spread over [start, end] by spoken word count ("1987" weighs three words, as it takes three to say). */
function spread(texts: string[], window: { start: number; end: number }, duration: number): SubtitleCue[] {
  const weights = texts.map((t) => Math.max(1, wordCount(t)));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0, window.end - window.start);
  let cum = 0;
  const raw = texts.map((text, i) => {
    const start = window.start + (span * cum) / total;
    cum += weights[i]!;
    return { start, end: window.start + (span * cum) / total + (i === texts.length - 1 ? CUE_TAIL : 0), text };
  });
  return settle(raw, duration);
}

/**
 * Time cue texts by ASR words: each cue runs from its first word's start to its last word's end + CUE_TAIL, then
 * min duration / no overlap / gap closing. Without timestamps (or when a cue can't be found in what was heard),
 * the cues are spread over `window` (the speech span) instead, and the result says so.
 */
export function timeCues(texts: string[], words: TranscriptWord[], opts: { window?: { start: number; end: number }; duration?: number } = {}): TimedCues {
  const duration = opts.duration ?? Infinity;
  const fallback = (note: string): TimedCues => {
    const window = opts.window ?? (words.length ? { start: words[0]!.start, end: words.at(-1)!.end } : undefined);
    if (!window) throw new Error(`subtitles: ${note}, and no speech window to spread the cues over`);
    return { cues: spread(texts, window, duration), timing: "spread", note };
  };
  if (texts.length === 0) throw new Error("subtitles: nothing to subtitle");
  if (words.length === 0) return fallback("no word timestamps");
  const spans = alignPieces(texts, words.map((w) => w.word));
  const missing = spans.findIndex((s) => s === undefined);
  if (missing >= 0) return fallback(`cue ${missing + 1} (${JSON.stringify(texts[missing])}) not found in the transcript`);
  const raw = texts.map((text, i) => ({ start: words[spans[i]!.first]!.start, end: words[spans[i]!.last]!.end + CUE_TAIL, text }));
  return { cues: settle(raw, duration), timing: "asr" };
}

export interface BurnResult {
  /** final.mp4, now with the cues burned in. */
  path: string;
  subtitles: Subtitles;
  attempts: Attempt[];
}

/**
 * The cut (`input`) → cards → overlaid → `<dir>/final.mp4`. Listens to the cut for word timestamps; `window` is the
 * speech span used when it has none.
 */
export async function burnSubtitles(
  input: string,
  script: Script,
  opts: { asr: AsrProvider; dir: string; window?: { start: number; end: number }; probe?: (path: string) => Promise<{ seconds: number }> },
): Promise<BurnResult> {
  const t0 = performance.now();
  const texts = cueTexts(script);
  assertCuesMatch(texts, script.shots.map((s) => splitDelivery(s.line).spoken).filter(Boolean).join(" "));
  const heard = await opts.asr.transcribe({ path: input });
  const { seconds } = await (opts.probe ?? ffprobe)(input);
  const timed = timeCues(texts, heard.words, { ...(opts.window ? { window: opts.window } : {}), duration: seconds });

  const cards: { png: string; start: number; end: number }[] = [];
  for (const cue of timed.cues) {
    const key = await contentKey("cue", CARD_VERSION, cue.text);
    const made = await once(join(opts.dir, `cue-${key}.png`), (tmp) => renderCard(cue.text, tmp));
    cards.push({ png: made.path, start: cue.start, end: cue.end });
  }
  const key = await contentKey("subtitles", { file: input }, ...cards.flatMap((c) => [{ file: c.png }, c.start, c.end]));
  const burned = await once(join(opts.dir, `subtitled-${key}.mp4`), async (tmp) => {
    await run(overlayCuesArgs({ input, out: tmp, cues: cards }));
    await linkSources(tmp, [{ source: input }]);
  });
  const final = join(opts.dir, FINAL_NAME);
  await rm(final, { force: true });
  await copyFile(burned.path, final);
  await linkSources(final, [{ source: burned.path }]);

  const how = timed.timing === "asr" ? "timed by ASR words" : `spread over the speech by word count (${timed.note})`;
  return {
    path: final,
    subtitles: { file: burned.path, cues: timed.cues, timing: timed.timing },
    attempts: [
      {
        stage: "subtitles",
        n: 1,
        provider: `${opts.asr.name}+resvg+ffmpeg`,
        ok: true,
        reason: `${timed.cues.length} cue(s) of the verified line, ${how}${burned.cached ? "; reused cached burn" : ""}`,
        costUsd: heard.costUsd,
        ms: Math.round(performance.now() - t0),
      },
    ],
  };
}
