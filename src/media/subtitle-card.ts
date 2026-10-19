/**
 * Subtitle cards (F13). This ffmpeg build has no drawtext / subtitles filters, so each cue is rendered to a
 * transparent 1080×1920 PNG with resvg (system fonts) and overlaid by ffmpeg for its time window.
 * The SVG builder and line wrapping are pure and tested; only renderCard touches the disk.
 */
import { writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { HEIGHT, WIDTH } from "./args.ts";

/** Part of every card's content key: bump on any change to the look. */
export const CARD_VERSION = "card-v2";

export const CARD = {
  fontSize: 68,
  lineHeight: 1.18,
  /** Baseline of the last line, as a fraction of the height: low, like My Muse (~86%), still clear of platform UI at the very bottom. */
  baseline: 0.84,
  /** Black outline visible outside the glyphs (the stroke is centred, so it is drawn at twice this width). */
  stroke: 6,
  maxChars: 32,
  maxLines: 2,
  family: "Arial, Helvetica, DejaVu Sans, sans-serif",
} as const;

/**
 * Text → at most `maxLines` lines of ≤ `maxChars`, broken at spaces only (never inside a word). Two lines are
 * balanced (the split that minimises the longer line). A single word longer than the limit stays whole.
 */
export function wrapLines(text: string, maxChars: number = CARD.maxChars): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const one = words.join(" ");
  if (one.length <= maxChars || words.length < 2) return [one];
  let best: string[] = [one];
  let worst = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const longer = Math.max(a.length, b.length);
    if (longer < worst) {
      worst = longer;
      best = [a, b];
    }
  }
  return best;
}

/** Does `text` fit the card (≤ maxLines lines of ≤ maxChars)? */
export const fitsCard = (text: string): boolean => {
  const lines = wrapLines(text);
  return lines.length <= CARD.maxLines && lines.every((l) => l.length <= CARD.maxChars);
};

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The card as SVG: white bold text, black outline, soft shadow, centred, last baseline at 84% of the height. */
export function cardSvg(text: string): string {
  const lines = wrapLines(text);
  const step = CARD.fontSize * CARD.lineHeight;
  const last = Math.round(HEIGHT * CARD.baseline);
  const ys = lines.map((_, i) => Math.round(last - (lines.length - 1 - i) * step));
  const cx = WIDTH / 2;
  const shadow = lines.map((l, i) => `<text x="${cx}" y="${ys[i]! + 5}" fill="#000" fill-opacity="0.55" filter="url(#soft)">${xml(l)}</text>`);
  const face = lines.map(
    (l, i) =>
      `<text x="${cx}" y="${ys[i]}" fill="#fff" stroke="#000" stroke-width="${CARD.stroke * 2}" stroke-linejoin="round" paint-order="stroke">${xml(l)}</text>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<defs><filter id="soft" x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="7"/></filter></defs>`,
    `<g font-family="${CARD.family}" font-weight="700" font-size="${CARD.fontSize}" text-anchor="middle">`,
    ...shadow,
    ...face,
    "</g></svg>",
  ].join("");
}

/** Renders the card to a transparent PNG at `out` (1080 px wide). */
export async function renderCard(text: string, out: string): Promise<void> {
  const png = new Resvg(cardSvg(text), {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: WIDTH },
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  })
    .render()
    .asPng();
  await writeFile(out, png);
}
