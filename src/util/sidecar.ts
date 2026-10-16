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

/** Transcript for `media`, following source links (max depth guards against a cycle). Undefined if none. */
export async function readTranscript(media: string, depth = 0): Promise<Transcript | undefined> {
  const t = await readJson(transcriptPath(media));
  if (t !== undefined) return Transcript.parse(t);
  const link = (await readJson(sourcePath(media))) as { source?: unknown } | undefined;
  if (typeof link?.source === "string" && depth < 8) return readTranscript(link.source, depth + 1);
  return undefined;
}
