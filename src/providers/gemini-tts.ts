/**
 * Live TTS: Gemini speech generation via the Interactions REST endpoint (free tier on the Gemini API).
 * Docs: https://ai.google.dev/gemini-api/docs/speech-generation
 * The docs say `text` is read as a verbatim transcript, so delivery goes in `speech_metadata.style`, never in text.
 */
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { ensureOk, envJson, pcmToWav, wavSeconds, type FetchLike } from "./http.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./types.ts";

export const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
/** Unary responses are 24 kHz mono 16-bit (WAV); raw PCM is wrapped at this rate. */
const SAMPLE_RATE = 24000;
/**
 * Cost estimate at the *paid* rate ($9 per 1M audio tokens, 25 tokens/s; docs/research/voice-lipsync-asr.md):
 * the free tier is really $0, but over-reporting a fraction of a cent is safer than under-reporting.
 */
const USD_PER_AUDIO_SECOND = (25 * 9) / 1_000_000;

/** `${gender}-${age}` → prebuilt voice (names and descriptors from the docs' voice list). Override: GEMINI_TTS_VOICES. */
export const GEMINI_VOICES: Record<string, string> = {
  "female-young": "Leda", // Youthful
  "female-adult": "Kore", // Firm
  "female-older": "Gacrux", // Mature
  "male-young": "Puck", // Upbeat
  "male-adult": "Charon", // Informative
  "male-older": "Algenib", // Gravelly
};

const InteractionResponse = z.object({
  steps: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), data: z.string().optional() })).optional(),
    }),
  ),
});

export class GeminiTts implements TtsProvider {
  readonly name = "gemini-tts";
  private readonly voices: Record<string, string>;
  constructor(
    private readonly opts: { apiKey: string; model?: string; voices?: Record<string, string>; fetch?: FetchLike },
  ) {
    this.voices = { ...GEMINI_VOICES, ...opts.voices };
  }

  static fromEnv(env: Record<string, string | undefined>, deps: { fetch?: FetchLike } = {}): GeminiTts {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("live tts provider is not configured: set GEMINI_API_KEY");
    return new GeminiTts({
      apiKey,
      model: env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL,
      voices: envJson(env, "GEMINI_TTS_VOICES"),
      ...deps,
    });
  }

  /** A voice key from the table, or a prebuilt voice name passed straight through. */
  voiceFor(voice: string): string {
    return this.voices[voice] ?? voice;
  }

  /** The request body exactly as documented (single speaker, unary). */
  body({ text, voice, emotion }: Pick<TtsRequest, "text" | "voice" | "emotion">): unknown {
    const part: Record<string, unknown> = { type: "text", text };
    if (emotion) part.annotations = [{ type: "speech_metadata", style: emotion }];
    return {
      model: this.opts.model ?? DEFAULT_GEMINI_TTS_MODEL,
      input: [{ type: "user_input", content: [part] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: this.voiceFor(voice) }] },
    };
  }

  /** Pre-call bound: a slow 0.6 s per word plus a second of breath, at the paid audio rate. */
  estimateUsd({ text }: TtsRequest): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return (words * 0.6 + 1) * USD_PER_AUDIO_SECOND;
  }

  async speak(req: TtsRequest): Promise<TtsResult> {
    // `variant` is not sent: the docs list no seed for TTS, so retries rely on sampling variety.
    const f = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    const res = await ensureOk(
      this.name,
      await f(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: { "x-goog-api-key": this.opts.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(this.body(req)),
      }),
    );
    const parsed = InteractionResponse.parse(await res.json());
    // Same selection as the docs' jq: last audio item of the model_output steps.
    const data = parsed.steps
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "audio" && c.data)
      .at(-1)?.data;
    if (!data) throw new Error(`${this.name}: response has no audio`);
    const wav = pcmToWav(Buffer.from(data, "base64"), SAMPLE_RATE);
    await writeFile(req.out, wav);
    const seconds = wavSeconds(wav);
    return { path: req.out, seconds, costUsd: seconds * USD_PER_AUDIO_SECOND, provider: this.name };
  }
}
