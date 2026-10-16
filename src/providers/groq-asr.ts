/**
 * Live ASR: Whisper on Groq's OpenAI-compatible transcription endpoint (free tier).
 * Docs: https://console.groq.com/docs/speech-to-text , https://console.groq.com/docs/api-reference
 * The reference line is deliberately NOT sent as `prompt`: a prompted ASR snaps back to the expected words
 * and would hide exactly the mistakes the verbatim gate exists to catch.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { extractAudioArgs } from "../media/args.ts";
import { run } from "../media/ffmpeg.ts";
import { ensureOk, type FetchLike } from "./http.ts";
import type { AsrProvider, AsrResult } from "./types.ts";

export const GROQ_ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const DEFAULT_GROQ_ASR_MODEL = "whisper-large-v3";
/** USD per audio hour, whisper-large-v3 (docs/research/voice-lipsync-asr.md); Groq bills at least 10 s a request. */
export const GROQ_USD_PER_HOUR = 0.111;
const MIN_BILLED_SECONDS = 10;

/** Containers Groq accepts as audio. Anything else (mp4 video, mov…) has its audio extracted first. */
const AUDIO_EXT = new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg", ".mpga", ".mpeg"]);

const VerboseJson = z.object({
  text: z.string(),
  duration: z.number().optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
});

export type Extractor = (input: string, out: string) => Promise<void>;
const ffmpegExtract: Extractor = (input, out) => run(extractAudioArgs({ input, out }));

export class GroqAsr implements AsrProvider {
  readonly name = "groq-whisper";
  constructor(
    private readonly opts: { apiKey: string; model?: string; fetch?: FetchLike; extract?: Extractor },
  ) {}

  static fromEnv(env: Record<string, string | undefined>, deps: { fetch?: FetchLike; extract?: Extractor } = {}): GroqAsr {
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) throw new Error("live asr provider is not configured: set GROQ_API_KEY");
    return new GroqAsr({ apiKey, model: env.GROQ_ASR_MODEL || DEFAULT_GROQ_ASR_MODEL, ...deps });
  }

  get model(): string {
    return this.opts.model ?? DEFAULT_GROQ_ASR_MODEL;
  }

  async transcribe({ path }: { path: string }): Promise<AsrResult> {
    if (AUDIO_EXT.has(extname(path).toLowerCase())) return this.send(path);
    const dir = await mkdtemp(join(tmpdir(), "itv-asr-"));
    try {
      const audio = join(dir, `${basename(path, extname(path))}.flac`);
      await (this.opts.extract ?? ffmpegExtract)(path, audio);
      return await this.send(audio);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async send(audio: string): Promise<AsrResult> {
    const form = new FormData();
    form.append("file", new Blob([await readFile(audio)]), basename(audio));
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("language", "en");
    form.append("temperature", "0");
    const f = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    // No Content-Type header: fetch sets multipart/form-data with the boundary itself.
    const res = await ensureOk(
      this.name,
      await f(GROQ_ASR_URL, { method: "POST", headers: { Authorization: `Bearer ${this.opts.apiKey}` }, body: form }),
    );
    const body = VerboseJson.parse(await res.json());
    const words = (body.words ?? [])
      .map((w) => ({ word: w.word.trim(), start: Math.max(0, w.start), end: Math.max(0, w.end, w.start) }))
      .filter((w) => w.word !== "");
    const billed = Math.max(MIN_BILLED_SECONDS, body.duration ?? words.at(-1)?.end ?? 0);
    return { text: body.text.trim(), words, costUsd: (billed / 3600) * GROQ_USD_PER_HOUR };
  }
}
