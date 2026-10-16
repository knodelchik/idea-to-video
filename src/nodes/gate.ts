/**
 * The verbatim gate on *audio*: nothing spoken is trusted until ASR has listened to it. Works on any audio or
 * video file (the ASR adapter extracts audio when it needs to).
 */
import type { AsrProvider } from "../providers/index.ts";
import type { Attempt, SpeechWindow, Transcript, TranscriptWord, VerbatimOp, VerbatimResult } from "../schemas.ts";
import { compareWords, splitDelivery } from "../verbatim.ts";

export type ListenResult = VerbatimResult &
  SpeechWindow & {
    transcript: Transcript;
    costUsd: number;
  };

/** First word start → last word end. No words → an empty window at 0. */
export function speechWindow(words: TranscriptWord[]): SpeechWindow {
  if (words.length === 0) return { speechStart: 0, speechEnd: 0 };
  return {
    speechStart: Math.min(...words.map((w) => w.start)),
    speechEnd: Math.max(...words.map((w) => w.end)),
  };
}

/**
 * Transcribe `path` and compare against `expected`. Delivery tags in `expected` ("[whispers]") are stripped
 * first: they are directions, not words, and must never be compared.
 */
export async function listen(path: string, expected: string, { asr }: { asr: AsrProvider }): Promise<ListenResult> {
  const t = await asr.transcribe({ path });
  const transcript = { text: t.text, words: t.words };
  const verbatim = compareWords(splitDelivery(expected).spoken, transcript.text);
  return { ...verbatim, ...speechWindow(transcript.words), transcript, costUsd: t.costUsd };
}

/** Diff ops as a short reason a human (or a retry prompt) can act on. */
export function describeOps(ops: VerbatimOp[]): string {
  return ops
    .map((o) =>
      o.type === "sub"
        ? `sub "${o.expected}" heard as "${o.heard}"`
        : o.type === "del"
          ? `del "${o.expected}" (missing)`
          : `ins "${o.heard}" (extra)`,
    )
    .join(", ");
}

/** Only the VerbatimResult fields (drops transcript/window/cost), so it parses against the contract. */
export function verbatimOf(r: VerbatimResult): VerbatimResult {
  return { expected: r.expected, heard: r.heard, wer: r.wer, ops: r.ops, pass: r.pass };
}

export class VerbatimError extends Error {
  constructor(
    readonly result: VerbatimResult,
    readonly attempts: Attempt[],
    stage = "voice",
  ) {
    super(
      `${stage}: not verbatim after ${attempts.length} attempts (wer ${result.wer.toFixed(2)}): ${describeOps(result.ops)}`,
    );
    this.name = "VerbatimError";
  }
}
