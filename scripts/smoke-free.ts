/**
 * npx tsx --env-file-if-exists=.env scripts/smoke-free.ts --yes [--image <path>]   (pnpm smoke:free --yes)
 * Live smoke test of the FREE-tier providers only: Gemini script writer → Gemini TTS of the line → Groq Whisper of
 * that audio (word error rate must be 0) → Gemini judge of one local image. Never touches fal, BytePlus or
 * ElevenLabs: those adapters are not even constructed, and a fetch guard refuses any host but Google's and Groq's.
 * Without --yes it prints the plan and exits 1. Exit 0 = every step answered and WER was 0.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeScript } from "../src/nodes/script.ts";
import { keyframeRubric } from "../src/prompts/judge.ts";
import { GeminiLlm } from "../src/providers/gemini.ts";
import { GeminiJudge, GeminiTts, GroqAsr } from "../src/providers/index.ts";
import { compareWords } from "../src/verbatim.ts";
import { SAMPLE_IDEA, SAMPLE_PNG } from "./preflight.ts";

export const FREE_HOSTS = new Set(["generativelanguage.googleapis.com", "api.groq.com"]);
export const USAGE = "usage: pnpm smoke:free --yes [--image <path>]";

/** Wraps fetch so only free-tier hosts can be reached from this process. */
export function guardFetch(inner: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!FREE_HOSTS.has(url.hostname)) throw new Error(`smoke-free: refusing non-free host ${url.hostname}`);
    return inner(input, init);
  }) as typeof fetch;
}

export function parseArgs(argv: string[]): { yes: boolean; image?: string } {
  const i = argv.indexOf("--image");
  const image = i >= 0 ? argv[i + 1] : undefined;
  return { yes: argv.includes("--yes"), ...(image ? { image } : {}) };
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const args = parseArgs(argv);
  console.log("smoke-free plan: Gemini script (free tier) → Gemini TTS (free tier) → Groq ASR (free tier) → Gemini judge (free tier)");
  console.log("never called: fal, BytePlus, ElevenLabs");
  if (!args.yes) {
    console.log(`not running: pass --yes to make these live calls. ${USAGE}`);
    return 1;
  }
  const missing = ["GEMINI_API_KEY", "GROQ_API_KEY"].filter((n) => !env[n]);
  if (missing.length) {
    console.error(`missing env: ${missing.join(", ")}`);
    return 1;
  }
  globalThis.fetch = guardFetch(globalThis.fetch);
  const dir = await mkdtemp(join(tmpdir(), "itv-smoke-free-"));
  let ok = true;

  // 1. Script
  const llm = GeminiLlm.fromEnv(env);
  const { script, attempts } = await writeScript(SAMPLE_IDEA, { llm });
  const shot = script.shots.find((s) => s.line !== "") ?? script.shots[0]!;
  console.log(JSON.stringify({ step: "script", title: script.title, line: shot.line, attempts: attempts.map((a) => ({ ok: a.ok, provider: a.provider, reason: a.reason, costUsd: a.costUsd })) }));

  // 2. TTS (Gemini only, whatever TTS_PROVIDERS says)
  const tts = GeminiTts.fromEnv(env);
  const wav = join(dir, "line.wav");
  const spoken = await tts.speak({ text: shot.line, voice: `${script.character.voice.gender}-${script.character.voice.age}`, emotion: shot.emotion, out: wav });
  console.log(JSON.stringify({ step: "tts", path: spoken.path, seconds: spoken.seconds }));

  // 3. ASR + verbatim check
  const asr = GroqAsr.fromEnv(env);
  const heard = await asr.transcribe({ path: wav });
  const v = compareWords(shot.line, heard.text);
  console.log(JSON.stringify({ step: "asr", heard: heard.text, words: heard.words.length, wer: v.wer, pass: v.pass }));
  if (!v.pass) ok = false;

  // 4. Judge one local image (Gemini image generation has no free tier, so nothing is generated)
  const image = args.image ?? join(dir, "sample.png");
  if (!args.image) await writeFile(image, SAMPLE_PNG);
  await readFile(image); // fail before the call when the path is wrong
  const judge = GeminiJudge.fromEnv(env);
  const verdict = await judge.judgeImage({ path: image, rubric: keyframeRubric(shot, script) });
  console.log(JSON.stringify({ step: "judge", image, model: verdict.model, score: verdict.score, issues: verdict.issues }));

  console.log(ok ? "SMOKE-FREE OK" : "SMOKE-FREE FAILED (verbatim WER > 0)");
  console.log(`artifacts: ${dir}`);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  });
}
