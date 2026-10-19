/**
 * Storyboard ideas (F12): an idea written shot by shot ("1 кадр: … 2 кадр: …", "Shot 1: … Shot 2: …", "1. … 2. …").
 * Code splits it, not the model, so the script can be held to exactly those shots in that order.
 * Pure: no I/O, no model.
 */
import { MAX_SHOTS } from "./schemas.ts";
import { quoteSpans } from "./verbatim.ts";

export interface Storyboard {
  /** Text before beat 1: shared context for every shot ("" when the idea starts with beat 1). */
  context: string;
  /** Beat descriptions in order, markers removed. beats[k] is shot s(k+1). */
  beats: string[];
  /** Where each beat's text starts and ends in the idea (end exclusive), to place quotes in beats. */
  spans: { start: number; end: number }[];
}

export const TOO_MANY_BEATS = `a storyboard has at most ${MAX_SHOTS} shots`;

/** A storyboard with more beats than shots. Raised before any model call (the idea can't be made as written). */
export class StoryboardError extends Error {
  constructor(readonly beats: number) {
    super(`${TOO_MANY_BEATS}; this idea has ${beats} numbered beats`);
    this.name = "StoryboardError";
  }
}

/**
 * Beat markers. A number alone ("2 coffees", "1987", "$4.50", "3:15") is never a marker: it needs the word
 * "кадр"/"shot" next to it, or a "." / ")" right after it followed by a space. Unicode-aware for Cyrillic.
 */
const MARKER = /(?:кадр|shot)\s*(\d{1,2})\b\s*[:.)\-–—]?|(\d{1,2})\s*(?:-?й\s*)?кадр(?![\p{L}])\s*[:.)\-–—]?|(\d{1,2})[.)](?=\s)/giu;

/**
 * A marker counts only at the start of the idea, of a line, or of a sentence/clause (after . ! ? … : ; and an optional
 * closing quote or bracket, or right after a closing quote: the spoken line ended). That keeps "she had 2. Then…"
 * style mid-sentence numbers out.
 */
const atBoundary = (text: string, at: number): boolean => {
  const before = text.slice(0, at).replace(/[ \t]+$/, "");
  return before === "" || /(?:[\n.!?…:;]["'»”)\]]?|["»”])$/.test(before);
};

/** Quoted spans blanked out (same length), so numbers inside a quoted line are never markers. */
function maskQuotes(idea: string): string {
  let spans: { start: number; end: number }[];
  try {
    spans = quoteSpans(idea);
  } catch {
    spans = []; // unreadable quotes are rejected elsewhere (QuoteError); here they just stay unmasked
  }
  let out = idea;
  for (const s of spans) out = out.slice(0, s.start) + " ".repeat(s.end - s.start) + out.slice(s.end);
  return out;
}

/**
 * Numbered beats 1..N (2 ≤ N ≤ MAX_SHOTS, consecutive from 1, each with some text). Null when the idea is not a
 * storyboard: fewer than 2 markers, numbers that skip or repeat, or an empty beat. Throws StoryboardError when the
 * beats are well-formed but more than MAX_SHOTS.
 */
export function parseStoryboard(idea: string): Storyboard | null {
  const masked = maskQuotes(idea);
  const marks: { n: number; start: number; end: number }[] = [];
  for (const m of masked.matchAll(MARKER)) {
    // Boundary on the original text: a beat ending in a quote (`says "Hi." Shot 2: …`) ends a sentence.
    if (!atBoundary(idea, m.index)) continue;
    marks.push({ n: Number(m[1] ?? m[2] ?? m[3]), start: m.index, end: m.index + m[0].length });
  }
  if (marks.length < 2) return null;
  if (!marks.every((m, i) => m.n === i + 1)) return null;

  const spans = marks.map((m, i) => ({ start: m.end, end: marks[i + 1]?.start ?? idea.length }));
  const beats = spans.map((s) => idea.slice(s.start, s.end).trim());
  if (beats.some((b) => b === "")) return null;
  if (beats.length > MAX_SHOTS) throw new StoryboardError(beats.length);
  return { context: idea.slice(0, marks[0]!.start).trim(), beats, spans };
}

/** For each quote (in quoteSpans order), the 0-based beat it sits in; -1 when it sits in the shared context. */
export function quoteBeats(idea: string, board: Storyboard): number[] {
  return quoteSpans(idea).map((q) => board.spans.findIndex((s) => q.start >= s.start && q.start < s.end));
}
