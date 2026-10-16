/**
 * npx tsx scripts/preflight.ts   (pnpm preflight)
 * Zero network, zero cost. Builds the exact live requests for one sample shot through the real adapters
 * (Seedance on fal + BytePlus, every image provider, Gemini TTS, ElevenLabs, Groq ASR, Gemini script + judge,
 * Kling lip-sync / avatar) with fake transports that record the request and stop it, then prints them as JSON.
 * Keys are never read into a request: every secret is replaced by "<redacted>" before an adapter sees it.
 * The env report lists variable NAMES only (set / missing), never values.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { talkingPrompt } from "../src/prompts/visuals.ts";
import { keyframeRubric } from "../src/prompts/judge.ts";
import { firstPrompt, SCRIPT_SYSTEM } from "../src/prompts/script.ts";
import { ScriptDraft, Script } from "../src/schemas.ts";
import { snapDuration } from "../src/nodes/visuals.ts";
import { extractQuotedLines } from "../src/verbatim.ts";
import {
  BytePlusSeedance,
  ElevenLabsTts,
  FalKlingAvatar,
  FalKlingLipsync,
  FalNanoBananaImage,
  FalSeedance,
  GeminiImage,
  GeminiJudge,
  GeminiTts,
  GroqAsr,
  SEEDANCE_DURATIONS,
  SeedreamImage,
  type FalLike,
  type FetchLike,
} from "../src/providers/index.ts";
import { GeminiLlm, type GenAiClient } from "../src/providers/gemini.ts";
import { pcmToWav } from "../src/providers/http.ts";

type Env = Record<string, string | undefined>;

export const SAMPLE_IDEA = 'A man on a rooftop tells his brother on the phone: "I kept the watch. I kept everything."';
export const SAMPLE_LINE = "I kept the watch. I kept everything.";
export const SAMPLE_SCRIPT: Script = Script.parse({
  promptVersion: "preflight",
  title: "The watch",
  logline: "A man tells his brother he kept their father's watch.",
  setting: "flat rooftop at dusk, city lights behind, wind",
  character: {
    name: "Dan",
    look: "late thirties, short dark beard, grey hoodie, tired brown eyes, small scar on the left eyebrow",
    voice: { gender: "male", age: "adult", tone: "low, steady" },
  },
  shots: [
    {
      id: "s1",
      camera: "medium close-up",
      visual: "Dan holds a phone to his ear, an old watch in his other hand",
      motion: "he lifts the watch into view",
      emotion: "quiet, hurt",
      line: SAMPLE_LINE,
      seconds: 6.2,
    },
    {
      id: "s2",
      camera: "close-up",
      visual: "Dan's face, eyes wet, city blurred behind",
      motion: "he lowers the phone slowly",
      emotion: "resigned",
      line: "",
      seconds: 4,
    },
  ],
  quotedLines: [SAMPLE_LINE],
});

/** 1×1 PNG: real magic bytes, so MIME sniffing and data URLs look exactly like a live keyframe's. */
export const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Env vars the live adapters read. Secrets are the *_KEY ones. */
export const ENV_VARS = [
  "GEMINI_API_KEY", "GROQ_API_KEY", "FAL_KEY", "ARK_API_KEY", "ELEVENLABS_API_KEY",
  "SEEDANCE_TRANSPORT", "SEEDANCE_TIER", "SEEDANCE_MODEL", "ARK_BASE_URL", "IMAGE_PROVIDER", "GEMINI_IMAGE_MODEL",
  "SEEDREAM_MODEL", "SEEDREAM_SIZE", "TTS_PROVIDERS", "GEMINI_TTS_MODEL", "GEMINI_TTS_VOICES", "ELEVENLABS_MODEL",
  "ELEVENLABS_VOICES", "GROQ_ASR_MODEL", "SCRIPT_MODELS", "JUDGE_MODELS", "LIPSYNC_PROVIDER", "LIPSYNC_CMD",
  "LIPSYNC_MAX_SECONDS", "MAX_COST_USD",
] as const;
const isSecret = (name: string): boolean => /(_KEY|TOKEN|SECRET|PASSWORD)$/.test(name);
export const REDACTED = "<redacted>";

/** Names only. */
export function envReport(env: Env): { set: string[]; missing: string[] } {
  return { set: ENV_VARS.filter((n) => !!env[n]), missing: ENV_VARS.filter((n) => !env[n]) };
}

/** The env adapters see: config passes through, every secret becomes a placeholder. */
export function safeEnv(env: Env): Env {
  const out: Env = {};
  for (const n of ENV_VARS) if (env[n]) out[n] = isSecret(n) ? REDACTED : env[n];
  return out;
}

class Captured extends Error {
  constructor() {
    super("preflight: request captured, not sent");
  }
}

/** Long strings (base64, data URLs, schemas' prose) shortened so the report stays readable. */
function shorten(v: unknown): unknown {
  if (typeof v === "string") return v.length > 1500 ? `${v.slice(0, 80)}…(${v.length} chars)` : v;
  if (Array.isArray(v)) return v.map(shorten);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
  return v;
}

function bodyOf(body: unknown): unknown {
  if (body instanceof FormData) {
    return {
      multipart: [...body.entries()].map(([k, v]) =>
        typeof v === "string" ? [k, v] : [k, { file: (v as File).name, type: v.type || "(none)", bytes: v.size }],
      ),
    };
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body ?? null;
}

type Req = Record<string, unknown>;

function recorders() {
  const log: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    log.push({ transport: "fetch", method: init.method ?? "GET", url, headers: init.headers ?? {}, body: bodyOf(init.body) });
    throw new Captured();
  };
  let uploads = 0;
  const fal: FalLike = {
    storage: {
      upload: async (file) => {
        const url = `https://v3.fal.media/files/<upload-${++uploads}>`;
        log.push({ transport: "fal.storage.upload", type: file.type, bytes: file.size, returns: url });
        return url;
      },
    },
    subscribe: async (endpoint, opts) => {
      log.push({
        transport: "@fal-ai/client subscribe (queue: POST https://queue.fal.run/<endpoint>, Authorization: Key <redacted>)",
        endpoint,
        input: opts.input,
      });
      throw new Captured();
    },
  };
  const genai: GenAiClient = {
    models: {
      generateContent: async (params) => {
        log.push({ transport: "@google/genai models.generateContent (x-goog-api-key: <redacted>)", params });
        throw new Captured();
      },
    },
  };
  return { log, fetch, fal, genai };
}

/** Runs one adapter call against recorders; returns exactly what it tried to send. */
async function capture(label: string, call: (r: ReturnType<typeof recorders>) => Promise<unknown>): Promise<Req> {
  const r = recorders();
  try {
    await call(r);
    return { label, error: "adapter returned without making a request" };
  } catch (e) {
    if (!(e instanceof Captured)) return { label, error: String(e), requests: r.log };
  }
  return { label, requests: r.log };
}

export async function buildPreflight(env: Env): Promise<Record<string, unknown>> {
  const safe = safeEnv(env);
  const dir = await mkdtemp(join(tmpdir(), "itv-preflight-"));
  try {
    const keyframe = join(dir, "keyframe.png");
    const portrait = join(dir, "portrait.png");
    const audio = join(dir, "line.wav");
    await writeFile(keyframe, SAMPLE_PNG);
    await writeFile(portrait, SAMPLE_PNG);
    await writeFile(audio, pcmToWav(new Uint8Array(24000 * 2 * 3), 24000)); // 3 s of silence

    const shot = SAMPLE_SCRIPT.shots[0]!;
    const seconds = snapDuration(shot.seconds, SEEDANCE_DURATIONS);
    const job = { image: keyframe, prompt: talkingPrompt(shot, SAMPLE_SCRIPT), seconds };
    const tier = safe.SEEDANCE_TIER === "fast" ? "fast" : "standard";
    const key = REDACTED;

    const requests = [
      await capture(`seedance fal (${tier})`, ({ fal }) => new FalSeedance({ fal, tier }).run(job)),
      await capture(`seedance byteplus (${tier})`, ({ fetch }) =>
        new BytePlusSeedance({
          apiKey: key,
          tier,
          fetch,
          ...(safe.SEEDANCE_MODEL ? { model: safe.SEEDANCE_MODEL } : {}),
          ...(safe.ARK_BASE_URL ? { base: safe.ARK_BASE_URL } : {}),
        }).run(job),
      ),
      await capture("image fal-nano-banana (keyframe, refs)", ({ fal, fetch }) =>
        new FalNanoBananaImage({ fal, fetch }).generate({ prompt: "keyframe prompt", refs: [portrait], out: join(dir, "a.png") }),
      ),
      await capture("image gemini (keyframe, refs)", ({ fetch }) =>
        new GeminiImage({ apiKey: key, fetch, ...(safe.GEMINI_IMAGE_MODEL ? { model: safe.GEMINI_IMAGE_MODEL } : {}) }).generate({
          prompt: "keyframe prompt",
          refs: [portrait],
          out: join(dir, "b.png"),
        }),
      ),
      await capture("image seedream (keyframe, refs)", ({ fetch }) =>
        new SeedreamImage({
          apiKey: key,
          fetch,
          ...(safe.SEEDREAM_MODEL ? { model: safe.SEEDREAM_MODEL } : {}),
          ...(safe.SEEDREAM_SIZE ? { size: safe.SEEDREAM_SIZE } : {}),
          ...(safe.ARK_BASE_URL ? { base: safe.ARK_BASE_URL } : {}),
        }).generate({ prompt: "keyframe prompt", refs: [portrait], out: join(dir, "c.png") }),
      ),
      await capture("tts gemini", ({ fetch }) =>
        GeminiTts.fromEnv({ ...safe, GEMINI_API_KEY: key }, { fetch }).speak({
          text: SAMPLE_LINE,
          voice: "male-adult",
          emotion: shot.emotion,
          out: join(dir, "t.wav"),
        }),
      ),
      await capture("tts elevenlabs", ({ fetch }) =>
        ElevenLabsTts.fromEnv({ ...safe, ELEVENLABS_API_KEY: key }, { fetch }).speak({
          text: SAMPLE_LINE,
          voice: "male-adult",
          emotion: shot.emotion,
          out: join(dir, "e.wav"),
        }),
      ),
      await capture("asr groq", ({ fetch }) => GroqAsr.fromEnv({ ...safe, GROQ_API_KEY: key }, { fetch }).transcribe({ path: audio })),
      await capture("llm gemini script (first model of the chain)", ({ genai }) =>
        GeminiLlm.fromEnv({ ...safe, GEMINI_API_KEY: key }, genai).generateJson({
          system: SCRIPT_SYSTEM,
          prompt: firstPrompt(SAMPLE_IDEA, extractQuotedLines(SAMPLE_IDEA)),
          schema: ScriptDraft as z.ZodType<unknown>,
        }),
      ),
      await capture("judge gemini (keyframe, first model of the chain)", ({ genai }) =>
        GeminiJudge.fromEnv({ ...safe, GEMINI_API_KEY: key }, genai).judgeImage({
          path: keyframe,
          rubric: keyframeRubric(shot, SAMPLE_SCRIPT),
          refs: [portrait],
        }),
      ),
      await capture("lipsync fal-kling", ({ fal, fetch }) =>
        new FalKlingLipsync({ fal, fetch, probe: async () => ({ seconds }) }).sync({ video: keyframe, audio, out: join(dir, "l.mp4") }),
      ),
      await capture("talking fal-kling-avatar standard", ({ fal, fetch }) =>
        new FalKlingAvatar({ fal, fetch }).talk({ image: keyframe, audio, prompt: job.prompt, out: join(dir, "k.mp4") }),
      ),
    ];

    const report = {
      note: "No request below was sent. Keys are placeholders; env lists names only.",
      sampleShot: { id: shot.id, line: shot.line, scriptSeconds: shot.seconds, seedanceSeconds: seconds },
      selected: {
        SEEDANCE_TRANSPORT: safe.SEEDANCE_TRANSPORT || "fal (default)",
        SEEDANCE_TIER: tier,
        IMAGE_PROVIDER: safe.IMAGE_PROVIDER || "fal-nano-banana (default)",
        LIPSYNC_PROVIDER: safe.LIPSYNC_PROVIDER || "fal-kling (default)",
      },
      env: envReport(env),
      requests: shorten(requests),
    };
    // Belt and braces: no real secret value may appear anywhere in the output.
    let text = JSON.stringify(report);
    for (const n of ENV_VARS.filter(isSecret)) {
      const v = env[n];
      if (v && v.length >= 6 && text.includes(v)) text = text.split(v).join(REDACTED);
    }
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // No `fetch` may leave this process: any adapter that bypassed injection would fail loudly here.
  globalThis.fetch = (async () => {
    throw new Error("preflight: network is disabled");
  }) as typeof fetch;
  const report = await buildPreflight(process.env);
  console.log(JSON.stringify(report, null, 2));
}
