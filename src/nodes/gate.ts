/**
 * The verbatim gate on *audio*: nothing spoken is trusted until ASR has listened to it. Works on any audio or
 * video file (the ASR adapter extracts audio when it needs to).
 */
import type { AsrProvider } from "../providers/index.ts";
import type { Attempt, SpeechWindow, Transcript, TranscriptWord, VerbatimOp, VerbatimResult } from "../schemas.ts";
import { compareWords, GATE_VERSION, hasLaughTag, splitDelivery } from "../verbatim.ts";

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
 * Transcribe `path` and compare against `expected` (a script line, or several joined). Delivery tags and emoji in
 * `expected` ("[whispers]", "🚀") are stripped first: they are not words and must never be compared. A laugh tag
 * lets heard laughter through; whatever was not counted is listed in `ignored`.
 */
export async function listen(
  path: string,
  expected: string,
  { asr, silences = [] }: { asr: AsrProvider; silences?: { start: number; end: number }[] },
): Promise<ListenResult & { hallucinated?: string }> {
  const t = await asr.transcribe({ path });
  // Words whose middle falls in digital silence can't have been said: ASR hallucination (live 2026-10-19: Whisper heard
  // "The American pronunciation guide presents…" over 5 s of silence). They are dropped and reported, never counted.
  const inSilence = (w: TranscriptWord) => silences.some((s) => (w.start + w.end) / 2 >= s.start && (w.start + w.end) / 2 <= s.end);
  const dropped = t.words.filter(inSilence);
  const words = dropped.length ? t.words.filter((w) => !inSilence(w)) : t.words;
  const transcript = { text: dropped.length ? words.map((w) => w.word.trim()).join(" ") : t.text, words };
  const hallucinated = dropped.length ? dropped.map((w) => w.word.trim()).join(" ") : undefined;
  // Same as compareLine, spelled out so compareWords only ever sees spoken words (tests spy on it).
  const { spoken, tags } = splitDelivery(expected);
  const verbatim = compareWords(spoken, transcript.text, { laughter: hasLaughTag(tags) });
  return { ...verbatim, ...speechWindow(transcript.words), transcript, costUsd: t.costUsd, ...(hallucinated ? { hallucinated } : {}) };
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
  return { expected: r.expected, heard: r.heard, wer: r.wer, ops: r.ops, pass: r.pass, ...(r.ignored ? { ignored: r.ignored } : {}) };
}

/**
 * What a gate attempt records about the check itself (F20): the rules' version, and on a miss what ASR heard. The
 * failure page diffs that text against the line, and a continue can tell a take the current rules already refused
 * (make new takes) from one an older version refused (re-gate it for $0).
 */
export function gated(heard: { pass: boolean; transcript: { text: string } }): Pick<Attempt, "gateVersion" | "heard"> {
  return { gateVersion: GATE_VERSION, ...(heard.pass ? {} : { heard: heard.transcript.text.slice(0, 500) }) };
}

/** ["ignored non-speech: (laughs), ha"] for an attempt reason, or []. Leniency is never silent (hard rule 6). */
export function describeIgnored(r: Pick<VerbatimResult, "ignored">): string[] {
  return r.ignored?.length ? [`ignored non-speech: ${r.ignored.join(", ")}`] : [];
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
