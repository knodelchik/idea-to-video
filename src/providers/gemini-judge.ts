/**
 * Live JudgeProvider: Gemini vision with structured output (responseJsonSchema = JudgeVerdict). Model chain
 * `JUDGE_MODELS`: first model that answers wins; 429/503 move on to the next and are reported in `notes`.
 * Images go inline as base64 `inlineData` parts (generateContent, @google/genai). A reply that fails JudgeVerdict
 * throws JudgeOutputError with its cost, so the caller records a judge failure instead of a pass.
 *
 * Image tokens (ai.google.dev/gemini-api/docs/tokens, checked 2026-10-16): 258 per 768×768 tile; a 1080×1920
 * frame is about 6 tiles. The estimate uses 1600 tokens per image.
 *
 * Video (F14): a clip goes inline as one `video/mp4` part with `videoMetadata.fps` (Part.videoMetadata in
 * @google/genai 2.30.0: fps in (0, 24], default 1). Gemini tokenizes video at 258 tokens per sampled frame plus 32
 * per second of audio (ai.google.dev/gemini-api/docs/video-understanding, checked 2026-10-19). Over the inline cap,
 * or on a 400 that names the video, the clip is judged on its frames instead and the notes say why.
 */
import { readFile, stat } from "node:fs/promises";
import { GoogleGenAI, type Part } from "@google/genai";
import { JudgeVerdict } from "../schemas.ts";
import { JudgeOutputError, parseVerdict } from "./errors.ts";
import { GEMINI_PRICES, geminiMeta, toGeminiSchema, type GenAiClient } from "./gemini.ts";
import { sniffMime } from "./http.ts";
import type { JudgeImageRequest, JudgeProvider, JudgeResult, JudgeVideoRequest } from "./types.ts";

// Same free-tier reasoning as DEFAULT_SCRIPT_MODELS; starts on a different model so script and judge quotas don't collide.
export const DEFAULT_JUDGE_MODELS = "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-flash-latest,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash";
export const JUDGE_TOKENS_PER_IMAGE = 1600;
/** Frames per second Gemini samples from a judged clip: dense enough to see a 4–15 s camera move. */
export const JUDGE_VIDEO_FPS = 4;
export const VIDEO_TOKENS_PER_FRAME = 258;
export const AUDIO_TOKENS_PER_SECOND = 32;
/** Inline requests must stay under Gemini's ~20 MB total; leave room for the rubric, refs and base64 framing. */
export const MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024;
/** Verdict JSON is short; leave room for thinking tokens, billed as output. */
const OUTPUT_TOKENS = 4000;
const UNAVAILABLE = new Set([404, 429, 503]); // 404 = model id not available to this key

export const JUDGE_SYSTEM =
  "You are a strict visual quality judge for short vertical videos. Score only what you can see. " +
  "Reply with JSON: score is an integer 1–10 (10 = flawless, 7 = usable, below 5 = unusable); issues lists each " +
  "concrete visible problem in a few words, empty when there are none.";

type Price = { input: number; output: number };

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A 400 whose message blames the video part (mime, size, video_metadata…), not the key or the rubric. */
const rejectsVideo = (e: unknown): boolean => statusOf(e) === 400 && /video|inline_?data|mime/i.test(errMsg(e));
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
const MAX_INLINE_VIDEO_MB = MAX_INLINE_VIDEO_BYTES / (1024 * 1024);

async function inline(path: string) {
  const b = await readFile(path);
  return { inlineData: { mimeType: sniffMime(b), data: b.toString("base64") } };
}

export class GeminiJudge implements JudgeProvider {
  readonly name = "gemini-judge";
  readonly models: string[];
  private readonly client: GenAiClient;
  private readonly prices: Record<string, Price>;
  private readonly fileSize: (path: string) => Promise<number>;

  /** `fileSize` is for tests (a fake oversized clip); it defaults to the file's real size. */
  constructor(opts: { client: GenAiClient; models: string[]; prices?: Record<string, Price>; fileSize?: (path: string) => Promise<number> }) {
    if (opts.models.length === 0) throw new Error("GeminiJudge: empty model chain");
    this.client = opts.client;
    this.models = opts.models;
    this.prices = opts.prices ?? GEMINI_PRICES;
    this.fileSize = opts.fileSize ?? (async (p) => (await stat(p)).size);
  }

  /** Key from GEMINI_API_KEY, chain from JUDGE_MODELS. `client` is for tests only. */
  static fromEnv(env: Record<string, string | undefined>, client?: GenAiClient): GeminiJudge {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("live judge provider is not configured: set GEMINI_API_KEY");
    const models = (env.JUDGE_MODELS || DEFAULT_JUDGE_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
    return new GeminiJudge({ client: client ?? new GoogleGenAI({ apiKey }), models });
  }

  /** Upper-ish bound at the dearest model in the chain (a fallback may answer). */
  estimateUsd({ images, rubric, videoSeconds = 0 }: { images: number; rubric: string; videoSeconds?: number }): number {
    const dearest = Math.max(...Object.values(this.prices).map((p) => p.output));
    const price = this.models
      .map((m) => this.prices[m] ?? { input: dearest, output: dearest })
      .reduce((a, b) => (b.output > a.output ? b : a));
    const video = Math.ceil(videoSeconds * JUDGE_VIDEO_FPS) * VIDEO_TOKENS_PER_FRAME + Math.ceil(videoSeconds) * AUDIO_TOKENS_PER_SECOND;
    const input = images * JUDGE_TOKENS_PER_IMAGE + video + Math.ceil((JUDGE_SYSTEM.length + rubric.length) / 4) + 500;
    return (input * price.input + OUTPUT_TOKENS * price.output) / 1_000_000;
  }

  async judgeImage({ path, rubric, refs = [] }: JudgeImageRequest): Promise<JudgeResult> {
    return this.ask(rubric, [{ label: "Image to judge:", paths: [path] }, { label: "Reference (the character portrait):", paths: refs }]);
  }

  async judgeVideo({ frames, rubric, refs = [], video }: JudgeVideoRequest): Promise<JudgeResult> {
    const ref = { label: "Reference (the character portrait):", paths: refs };
    const onFrames = async (why?: string): Promise<JudgeResult> => {
      const r = await this.ask(rubric, [{ label: `${frames.length} frames sampled evenly from the clip, in order:`, paths: frames }, ref]);
      return why ? { ...r, notes: [`${why}; judged ${frames.length} frames instead`, ...(r.notes ?? [])] } : r;
    };
    if (!video) return onFrames();
    const size = await this.fileSize(video);
    if (size > MAX_INLINE_VIDEO_BYTES) return onFrames(`video ${mb(size)} MB is over the ${MAX_INLINE_VIDEO_MB} MB inline limit`);
    const data = (await readFile(video)).toString("base64");
    const clip: Part = { inlineData: { mimeType: "video/mp4", data }, videoMetadata: { fps: JUDGE_VIDEO_FPS } };
    try {
      return await this.ask(rubric, [{ label: "The clip to judge:", parts: [clip] }, ref]);
    } catch (e) {
      if (!rejectsVideo(e)) throw e;
      return onFrames(`video rejected (400): ${errMsg(e)}`);
    }
  }

  private async ask(rubric: string, groups: ({ label: string; paths: string[] } | { label: string; parts: Part[] })[]): Promise<JudgeResult> {
    const parts: Part[] = [{ text: rubric }];
    for (const g of groups) {
      const media = "parts" in g ? g.parts : await Promise.all(g.paths.map(inline));
      if (media.length) parts.push({ text: g.label }, ...media);
    }
    const notes: string[] = [];
    for (const model of this.models) {
      let res: Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>;
      try {
        res = await this.client.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: JUDGE_SYSTEM,
            responseMimeType: "application/json",
            responseJsonSchema: toGeminiSchema(JudgeVerdict),
            temperature: 0, // as deterministic as the model allows: scores should compare across runs
          },
        });
      } catch (e) {
        const status = statusOf(e);
        if (status !== undefined && UNAVAILABLE.has(status)) {
          notes.push(`model ${model} unavailable (${status}), trying next`);
          continue;
        }
        throw e;
      }
      const costUsd = this.cost(model, res.usageMetadata, notes);
      const text = res.text ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text; // fails the schema below → JudgeOutputError with the cost
      }
      const meta = geminiMeta(res);
      let verdict;
      try {
        verdict = parseVerdict(`${this.name}(${model})`, raw, costUsd);
      } catch (e) {
        // An empty or malformed reply: the trace needs to say why (finishReason MAX_TOKENS, SAFETY…), F16.
        if (e instanceof JudgeOutputError) e.meta = meta;
        throw e;
      }
      return { ...verdict, costUsd, model, ...(notes.length ? { notes } : {}), meta };
    }
    throw new Error(`GeminiJudge: all models unavailable: ${notes.join("; ")}`);
  }

  private cost(model: string, usage: Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>["usageMetadata"], notes: string[]): number {
    const price = this.prices[model];
    if (!price) {
      notes.push(`no price for model ${model}; cost recorded as 0`);
      return 0;
    }
    const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    return ((usage?.promptTokenCount ?? 0) * price.input + output * price.output) / 1_000_000;
  }
}
