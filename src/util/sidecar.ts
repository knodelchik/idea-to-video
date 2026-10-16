/**
 * Transcript sidecars: `<media>.transcript.json` holds what a mock "said" in that file, so the mock ASR can
 * hear it back. When code muxes audio into a new file it can leave `<out>.source.json` pointing at the file
 * that carries the speech; readTranscript follows those links.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Transcript } from "../schemas.ts";

export const transcriptPath = (media: string): string => `${media}.transcript.json`;
export const sourcePath = (media: string): string => `${media}.source.json`;

export async function writeTranscript(media: string, t: Transcript): Promise<void> {
  await writeFile(transcriptPath(media), JSON.stringify(Transcript.parse(t), null, 2));
}

/** Record that the speech in `media` came from `source` (used when muxing outside a mock). */
export async function linkSource(media: string, source: string): Promise<void> {
  await writeFile(sourcePath(media), JSON.stringify({ source }));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** One piece of an edited file: `source`'s speech, cut at `until` s (source time), placed at `offset` s. */
export interface SourcePart {
  source: string;
  offset?: number;
  until?: number;
}

/**
 * Record that `media` is an edit of several sources (a cut, a concat). Assembly calls this so the mock ASR hears
 * the final file as the real one would: each piece's words, shifted to where the piece sits, cut where it ends.
 */
export async function linkSources(media: string, parts: SourcePart[]): Promise<void> {
  await writeFile(sourcePath(media), JSON.stringify({ sources: parts }));
}

interface Link {
  source?: unknown;
  sources?: { source?: unknown; offset?: unknown; until?: unknown }[];
}

const r3 = (n: number) => Number(n.toFixed(3));

/** Transcript for `media`, following source links (max depth guards against a cycle). Undefined if none. */
export async function readTranscript(media: string, depth = 0): Promise<Transcript | undefined> {
  const t = await readJson(transcriptPath(media));
  if (t !== undefined) return Transcript.parse(t);
  if (depth >= 8) return undefined;
  const link = (await readJson(sourcePath(media))) as Link | undefined;
  if (typeof link?.source === "string") return readTranscript(link.source, depth + 1);
  if (!Array.isArray(link?.sources)) return undefined;
  const words: Transcript["words"] = [];
  let heardAny = false;
  for (const part of link.sources) {
    if (typeof part.source !== "string") continue;
    const sub = await readTranscript(part.source, depth + 1);
    if (!sub) continue;
    heardAny = true;
    const offset = typeof part.offset === "number" ? part.offset : 0;
    const until = typeof part.until === "number" ? part.until : Infinity;
    for (const w of sub.words) {
      // A word that starts after the cut is gone; one that straddles it is clipped, as the audio is.
      if (w.start >= until) continue;
      words.push({ word: w.word, start: r3(w.start + offset), end: r3(Math.min(w.end, until) + offset) });
    }
  }
  return heardAny ? { text: words.map((w) => w.word).join(" "), words } : undefined;
}
