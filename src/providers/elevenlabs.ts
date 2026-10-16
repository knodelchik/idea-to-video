/**
 * Live TTS (optional): ElevenLabs Eleven v3, emotion as an inline audio tag prefix ("[whispers] …").
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert , https://elevenlabs.io/docs/overview/models
 * Raw PCM is requested and wrapped as WAV here, so no transcoding step and the duration is exact.
 */
import { writeFile } from "node:fs/promises";
import { ensureOk, envJson, pcmToWav, wavSeconds, type FetchLike } from "./http.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./types.ts";

export const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_v3";
const OUTPUT_FORMAT = "pcm_24000";
const SAMPLE_RATE = 24000;
/** $0.08 per 1k characters for v3 (elevenlabs.io/pricing/api, see docs/research/voice-lipsync-asr.md). */
const USD_PER_CHAR = 0.08 / 1000;

/**
 * `${gender}-${age}` → premade voice id. These are long-standing premade voices, but availability per account
 * is not guaranteed: override with ELEVENLABS_VOICES='{"female-adult":"<voice_id>", …}'.
 */
export const ELEVENLABS_VOICES: Record<string, string> = {
  "female-young": "EXAVITQu4vr4xnSDxMaL",
  "female-adult": "21m00Tcm4TlvDq8ikWAM",
  "female-older": "XrExE9yKIg1WjnnlVkGX",
  "male-young": "TX3LPaxmHKxFdv7VOQHJ",
  "male-adult": "pNInz6obpgDQGcFmaJgB",
  "male-older": "JBFqnCBsd6RMkjVDRZzb",
};

/** "[whispers] " prefix; brackets inside the emotion are stripped so it stays one tag. */
export function audioTag(emotion: string | undefined): string {
  const tag = (emotion ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  return tag ? `[${tag}] ` : "";
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  private readonly voices: Record<string, string>;
  constructor(
    private readonly opts: { apiKey: string; model?: string; voices?: Record<string, string>; fetch?: FetchLike },
  ) {
    this.voices = { ...ELEVENLABS_VOICES, ...opts.voices };
  }

  static fromEnv(env: Record<string, string | undefined>, deps: { fetch?: FetchLike } = {}): ElevenLabsTts {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("live tts provider is not configured: set ELEVENLABS_API_KEY");
    return new ElevenLabsTts({
      apiKey,
      model: env.ELEVENLABS_MODEL || DEFAULT_ELEVENLABS_MODEL,
      voices: envJson(env, "ELEVENLABS_VOICES"),
      ...deps,
    });
  }

  voiceFor(voice: string): string {
    return this.voices[voice] ?? voice;
  }

  url(voice: string): string {
    return `${ELEVENLABS_URL}/${encodeURIComponent(this.voiceFor(voice))}?output_format=${OUTPUT_FORMAT}`;
  }

  body({ text, emotion, variant }: Pick<TtsRequest, "text" | "emotion" | "variant">): Record<string, unknown> {
    return {
      text: `${audioTag(emotion)}${text}`,
      model_id: this.opts.model ?? DEFAULT_ELEVENLABS_MODEL,
      // Documented best-effort determinism: same variant → same take; a retry asks for a different one.
      seed: variant ?? 0,
    };
  }

  async speak(req: TtsRequest): Promise<TtsResult> {
    const f = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    const body = this.body(req);
    const res = await ensureOk(
      this.name,
      await f(this.url(req.voice), {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json", Accept: "audio/*" },
        body: JSON.stringify(body),
      }),
    );
    const wav = pcmToWav(new Uint8Array(await res.arrayBuffer()), SAMPLE_RATE);
    await writeFile(req.out, wav);
    return {
      path: req.out,
      seconds: wavSeconds(wav),
      costUsd: String(body.text).length * USD_PER_CHAR,
      provider: this.name,
    };
  }
}
