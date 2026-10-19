/**
 * Live LlmProvider on @google/genai. The client is injected so tests run against a fake (no network).
 * Model chain: first model that answers wins; 429/503 move on to the next and are reported in `notes`.
 */
import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import { z } from "zod";
import { formatIssues } from "../schemas.ts";
import type { CallMeta, LlmProvider, LlmRequest, LlmResult } from "./types.ts";

/** What generateContent returns that we read. */
export interface GenAiResponse {
  text?: string | undefined;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
  /** Why generation stopped (STOP, MAX_TOKENS, SAFETY…): explains an empty reply (F16). */
  candidates?: { finishReason?: string | undefined }[] | undefined;
  /** Set when the prompt itself was blocked. */
  promptFeedback?: { blockReason?: string | undefined; blockReasonMessage?: string | undefined } | undefined;
}

/** The slice of GoogleGenAI we use; the real client satisfies it structurally. */
export interface GenAiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenAiResponse>;
  };
}

/** Trace metadata of one reply (F16): the raw text, finish reason, prompt block reason and token usage. */
export function geminiMeta(res: GenAiResponse): CallMeta {
  const u = res.usageMetadata;
  const finishReason = res.candidates?.[0]?.finishReason;
  const pf = res.promptFeedback;
  const promptFeedback = pf?.blockReason ? [pf.blockReason, pf.blockReasonMessage].filter(Boolean).join(": ") : undefined;
  return {
    text: res.text ?? "",
    ...(finishReason ? { finishReason } : {}),
    ...(promptFeedback ? { promptFeedback } : {}),
    ...(u
      ? {
          usage: {
            input: u.promptTokenCount ?? 0,
            output: u.candidatesTokenCount ?? 0,
            ...(u.thoughtsTokenCount ? { thinking: u.thoughtsTokenCount } : {}),
          },
        }
      : {}),
  };
}

/**
 * USD per 1M tokens, paid tier, prompts ≤200k (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-19; 3.8/3.6
 * Flash double on 2027-01-01). Every model in DEFAULT_SCRIPT_MODELS and DEFAULT_JUDGE_MODELS must be here (tested),
 * or a paid call is recorded as $0. The pricing page lists no gemini-3.5-flash and no `*-latest` alias (the models
 * page only says an alias "points to the latest release" of a variation), so those are priced at the current
 * top of their family — an over-estimate is safe for the budget, an under-estimate is not.
 */
export const GEMINI_PRICES: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash": { input: 0.75, output: 3.75 }, // not on the pricing page: priced as the current Flash tier
  "gemini-flash-latest": { input: 0.75, output: 3.75 }, // alias → latest Flash (3.8 Flash price)
  "gemini-flash-lite-latest": { input: 0.3, output: 2.5 }, // alias → latest Flash-Lite (3.5 Flash-Lite price)
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

// The free tier allows ~20 requests/day *per model* and new projects can't use gemini-2.5-*, so the default chain
// is long and only contains models verified on a fresh AI Studio key (idea-to-episode, 2026-10).
export const DEFAULT_SCRIPT_MODELS = "gemini-3.8-flash,gemini-3.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite";

/** Statuses that mean "this model is busy/unavailable right now", not "your request is wrong". */
// 404: the model id is not available to this key (e.g. retired for new projects) -> try the next one, with a note.
const UNAVAILABLE = new Set([404, 429, 503]);

/** Keywords Gemini's structured-output docs list; anything else (e.g. $schema, minLength) is dropped. */
const ALLOWED = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties", "enum", "format",
  "minimum", "maximum", "items", "prefixItems", "minItems", "maxItems", "anyOf",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, sanitize(sub)]));
    } else out[k] = k === "enum" || k === "required" ? v : sanitize(v);
  }
  return out;
}

/** JSON schema for responseJsonSchema. Zod still validates the full contract (refinements, lengths) afterwards. */
export function toGeminiSchema(schema: z.ZodType): unknown {
  return sanitize(z.toJSONSchema(schema));
}

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
};

export class GeminiLlm implements LlmProvider {
  readonly name = "gemini";
  readonly models: string[];
  private readonly client: GenAiClient;
  private readonly prices: Record<string, { input: number; output: number }>;

  constructor(opts: { client: GenAiClient; models: string[]; prices?: Record<string, { input: number; output: number }> }) {
    if (opts.models.length === 0) throw new Error("GeminiLlm: empty model chain");
    this.client = opts.client;
    this.models = opts.models;
    this.prices = opts.prices ?? GEMINI_PRICES;
  }

  /** Key from GEMINI_API_KEY, chain from SCRIPT_MODELS. `client` is for tests only. */
  static fromEnv(env: Record<string, string | undefined>, client?: GenAiClient): GeminiLlm {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("live llm provider is not configured: set GEMINI_API_KEY");
    const models = (env.SCRIPT_MODELS ?? DEFAULT_SCRIPT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
    return new GeminiLlm({ client: client ?? new GoogleGenAI({ apiKey }), models });
  }

  /**
   * Pre-call bound for the budget guard: ~4 chars/token in, a generous 8k tokens out (thinking included), at the
   * priciest model in the chain since a fallback may answer. Unknown price → the dearest listed one.
   */
  estimateUsd({ system, prompt }: { system: string; prompt: string }): number {
    const dearest = Math.max(...Object.values(this.prices).map((p) => p.output));
    const price = this.models.reduce(
      (worst, m) => {
        const p = this.prices[m] ?? { input: dearest, output: dearest };
        return p.output > worst.output ? p : worst;
      },
      { input: 0, output: 0 },
    );
    const input = Math.ceil((system.length + prompt.length) / 4) + 1000; // + the JSON schema
    return (input * price.input + 8000 * price.output) / 1_000_000;
  }

  async generateJson<T>({ system, prompt, schema, temperature }: LlmRequest<T>): Promise<LlmResult<T>> {
    const notes: string[] = [];
    const responseJsonSchema = toGeminiSchema(schema);
    for (const model of this.models) {
      let res: Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>;
      try {
        res = await this.client.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema,
            ...(temperature === undefined ? {} : { temperature }),
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
      const meta = { model, ...(notes.length ? { notes } : {}), meta: geminiMeta(res) };
      const text = res.text ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, error: `response is not valid JSON: ${text.slice(0, 200)}`, raw: text, costUsd, ...meta };
      }
      const parsed = schema.safeParse(raw);
      return parsed.success
        ? { ok: true, data: parsed.data, raw, costUsd, ...meta }
        : { ok: false, error: formatIssues(parsed.error), raw, costUsd, ...meta };
    }
    throw new Error(`GeminiLlm: all models unavailable: ${notes.join("; ")}`);
  }

  private cost(model: string, usage: Awaited<ReturnType<GenAiClient["models"]["generateContent"]>>["usageMetadata"], notes: string[]): number {
    const price = this.prices[model];
    if (!price) {
      notes.push(`no price for model ${model}; cost recorded as 0`);
      return 0;
    }
    const input = usage?.promptTokenCount ?? 0;
    // Output price covers thinking tokens too.
    const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    return (input * price.input + output * price.output) / 1_000_000;
  }
}
