/**
 * Fallback voice: TTS → listen → retry, until the track says the line word for word. Used when native video
 * speech keeps failing; F05 lip-syncs the result onto the clip.
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { probe } from "../media/ffmpeg.ts";
import type { AsrProvider, TtsProvider } from "../providers/index.ts";
import { VoiceTrack, type Attempt, type Character, type VerbatimResult } from "../schemas.ts";
import { contentKey, once } from "../util/cache.ts";
import { splitDelivery } from "../verbatim.ts";
import { describeOps, listen, VerbatimError, verbatimOf } from "./gate.ts";

/** Provider-neutral voice key; each TTS adapter maps it to its own voice (and lets env override the table). */
export const voiceKey = (c: Character): string => `${c.voice.gender}-${c.voice.age}`;

export interface VerifiedVoiceOpts {
  tts: TtsProvider;
  asr: AsrProvider;
  /** Where takes are written (content-addressed names, so a resumed run reuses finished takes). */
  dir: string;
  maxAttempts?: number;
  /** Delivery for the whole line (e.g. the shot's emotion). Sent as a setting/tag, never compared. */
  emotion?: string;
  shotId?: "s1" | "s2";
}

export type VerifiedVoice = VoiceTrack & { attempts: Attempt[] };

export async function verifiedVoice(line: string, character: Character, opts: VerifiedVoiceOpts): Promise<VerifiedVoice> {
  const { tts, asr, dir, maxAttempts = 3, shotId } = opts;
  if (maxAttempts < 1) throw new RangeError(`maxAttempts must be >= 1, got ${maxAttempts}`);
  // Inline tags in the line ("[whispers] …") join the emotion; only the words go to TTS text and to the gate.
  const { spoken, tags } = splitDelivery(line);
  if (spoken === "") throw new Error("verifiedVoice: the line has no words to speak");
  const emotion = [opts.emotion?.trim(), ...tags].filter(Boolean).join(", ") || undefined;
  const voice = voiceKey(character);

  const attempts: Attempt[] = [];
  let last: VerbatimResult | undefined;
  for (let n = 1; n <= maxAttempts; n++) {
    // variant 0 is the provider's default take; each retry asks for a different one.
    const variant = n - 1;
    const t0 = performance.now();
    const key = await contentKey("voice", tts.name, spoken, voice, emotion ?? "", variant);
    const made = await once(join(dir, `voice-${key}.wav`), (tmp) =>
      tts.speak({ text: spoken, voice, out: tmp, variant, ...(emotion ? { emotion } : {}) }),
    );
    const seconds = made.result?.seconds ?? (await probe(made.path)).seconds;
    const heard = await listen(made.path, spoken, { asr });
    last = verbatimOf(heard);

    const reason = [
      ...(made.cached ? ["reused cached take"] : []),
      ...(made.result?.notes ?? []),
      ...(heard.pass ? [] : [describeOps(heard.ops)]),
    ].join("; ");
    attempts.push({
      stage: "voice",
      ...(shotId ? { shotId } : {}),
      n,
      provider: `${made.result?.provider ?? tts.name}+${asr.name}`,
      ok: heard.pass,
      ...(reason ? { reason } : {}),
      costUsd: (made.result?.costUsd ?? 0) + heard.costUsd,
      ms: Math.round(performance.now() - t0),
    });

    if (heard.pass) {
      // Parse through the contract: a passing transcript with no timed words is still unusable for lip-sync.
      const track = VoiceTrack.parse({
        path: made.path,
        seconds,
        speechStart: heard.speechStart,
        speechEnd: heard.speechEnd,
        verbatim: last,
      });
      return { ...track, attempts };
    }
  }
  throw new VerbatimError(last!, attempts);
}
