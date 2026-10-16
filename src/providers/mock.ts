/**
 * Deterministic, zero-cost providers built on local ffmpeg. They let agents and CI run the whole pipeline.
 * Speech is a quiet tone; *what* was said travels in a transcript sidecar that MockAsr reads back.
 * Fault injection (by 0-based call index) lets tests exercise every retry/fallback branch.
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIssues, type Transcript } from "../schemas.ts";
import { colorImageArgs, muxArgs, stillVideoArgs, toneArgs } from "../media/args.ts";
import { probe, run } from "../media/ffmpeg.ts";
import { readTranscript, writeTranscript } from "../util/sidecar.ts";
import { parseVerdict, PolicyRejectedError } from "./errors.ts";
import type {
  AnimateRequest,
  AnimateResult,
  AsrProvider,
  AsrResult,
  ImageProvider,
  ImageRequest,
  JudgeImageRequest,
  JudgeProvider,
  JudgeResult,
  JudgeVideoRequest,
  LipsyncProvider,
  LlmProvider,
  LlmRequest,
  LlmResult,
  TalkingProvider,
  TtsProvider,
  TtsRequest,
  TtsResult,
  VideoCapabilities,
  VideoProvider,
} from "./types.ts";

/** Mock speaking rate: ~0.38 s per word, plus 0.3 s of tail. */
export const MOCK_SECONDS_PER_WORD = 0.38;
export const MOCK_TAIL_SECONDS = 0.3;
/** Where native mock speech starts inside a generated clip. */
export const MOCK_SPEECH_OFFSET = 0.3;

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

export const mockSpeechSeconds = (text: string): number =>
  Number((words(text).length * MOCK_SECONDS_PER_WORD + MOCK_TAIL_SECONDS).toFixed(3));

/** Evenly timed words starting at `offset`, dropping any that would start after `limit`. */
export function mockTranscript(text: string, offset = 0, limit = Infinity): Transcript {
  const ws = words(text)
    .map((word, i) => {
      const start = Number((offset + 0.15 + i * MOCK_SECONDS_PER_WORD).toFixed(3));
      return { word, start, end: Number((start + MOCK_SECONDS_PER_WORD - 0.04).toFixed(3)) };
    })
    .filter((w) => w.start < limit);
  return { text: ws.map((w) => w.word).join(" "), words: ws };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "itv-mock-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- LLM ---

export type Responder = (prompt: string, ctx: { system: string; call: number }) => unknown;

/** Canned LLM: a responder function, or a queue consumed one object per call. */
export class MockLlm implements LlmProvider {
  readonly name = "mock-llm";
  readonly calls: { system: string; prompt: string; temperature?: number }[] = [];
  private readonly queue: unknown[];
  private readonly responder?: Responder;

  constructor(opts: { responder?: Responder; queue?: unknown[] } = {}) {
    this.responder = opts.responder;
    this.queue = [...(opts.queue ?? [])];
  }

  async generateJson<T>({ system, prompt, schema, temperature }: LlmRequest<T>): Promise<LlmResult<T>> {
    const call = this.calls.length;
    this.calls.push({ system, prompt, ...(temperature === undefined ? {} : { temperature }) });
    let raw: unknown;
    if (this.responder) raw = this.responder(prompt, { system, call });
    else if (this.queue.length > 0) raw = this.queue.shift();
    else throw new Error(`MockLlm: no canned response for call ${call}`);
    // Round-trip through JSON like a real model's text output would (drops undefined, functions, etc.).
    raw = JSON.parse(JSON.stringify(raw ?? null)) as unknown;
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, data: parsed.data, raw, costUsd: 0 }
      : { ok: false, error: formatIssues(parsed.error), raw, costUsd: 0 };
  }
}

/** Line the mock writer uses when the idea quotes none. Plain words, no digits (passes scriptProblems). */
export const MOCK_DEFAULT_LINE = "I never stopped looking for you.";

/**
 * A script draft for any idea, read back out of the script prompt (`Idea:` block + `- "quoted line"` bullets), so
 * `pnpm make --mock` runs end to end with no canned queue. Shape: a silent 4 s establishing shot, then the
 * line(s); every shot is long enough for its words (words / 2.6 + 0.8 s, rounded up, plus 1 s of room).
 */
export const mockScriptResponder: Responder = (prompt) => {
  const idea = /Idea:\n([\s\S]*?)\n\n/.exec(prompt)?.[1]?.trim() || "a quiet moment";
  const quoted = [...prompt.matchAll(/^- (".*")$/gm)].map((m) => JSON.parse(m[1]!) as string).slice(0, 2);
  const lines = quoted.length ? quoted : [MOCK_DEFAULT_LINE];
  const secondsFor = (line: string) => Math.min(15, Math.max(5, Math.ceil(words(line).length / 2.6 + 0.8) + 1));
  const shot = (id: "s1" | "s2", line: string, seconds: number) => ({
    id,
    camera: "close-up",
    visual: `The character in the scene from the idea: ${idea}`,
    motion: "slow push-in",
    emotion: line ? "quiet resolve" : "stillness",
    line,
    seconds,
  });
  const shots =
    lines.length === 2
      ? lines.map((l, i) => shot(i === 0 ? "s1" : "s2", l, secondsFor(l)))
      : [shot("s1", "", 4), shot("s2", lines[0]!, secondsFor(lines[0]!))];
  return {
    title: "Mock beat",
    logline: idea,
    setting: "a dim interior at night",
    character: {
      name: "Alex",
      look: "a woman in her thirties with short dark hair, a grey wool coat, a small scar above the left eyebrow",
      voice: { gender: "female", age: "adult", tone: "low and steady" },
    },
    shots,
  };
};

// --- TTS ---

export class MockTts implements TtsProvider {
  readonly name = "mock-tts";
  /** Every request, in order (tests assert on the call log). */
  readonly calls: TtsRequest[] = [];
  async speak(req: TtsRequest): Promise<TtsResult> {
    this.calls.push(req);
    const { text, out } = req;
    if (words(text).length === 0) throw new Error("MockTts: empty text");
    const seconds = mockSpeechSeconds(text);
    await run(toneArgs({ out, seconds }));
    await writeTranscript(out, mockTranscript(text));
    return { path: out, seconds, costUsd: 0 };
  }
}

// --- ASR ---

export interface AsrFault {
  /** 0-based transcribe() call this applies to. */
  call: number;
  /** Drop this many words from the end. */
  drop?: number;
  /** Replace words (case- and punctuation-insensitive match) → new word. */
  replace?: Record<string, string>;
  /** Hear this text instead, entirely. */
  text?: string;
}

export function applyAsrFault(t: Transcript, f: AsrFault): Transcript {
  if (f.text !== undefined) return mockTranscript(f.text, Math.max(0, (t.words[0]?.start ?? 0.15) - 0.15));
  const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const repl = new Map(Object.entries(f.replace ?? {}).map(([k, v]) => [bare(k), v]));
  let ws = t.words.map((w) => ({ ...w, word: repl.get(bare(w.word)) ?? w.word }));
  if (f.drop) ws = ws.slice(0, Math.max(0, ws.length - f.drop));
  return { text: ws.map((w) => w.word).join(" "), words: ws };
}

export class MockAsr implements AsrProvider {
  readonly name = "mock-asr";
  private calls = 0;
  private readonly faults: AsrFault[];
  constructor(opts: { faults?: AsrFault[] } = {}) {
    this.faults = opts.faults ?? [];
  }

  async transcribe({ path }: { path: string }): Promise<AsrResult> {
    const call = this.calls++;
    await access(path); // a missing file is a bug upstream, not silence
    let t = (await readTranscript(path)) ?? { text: "", words: [] };
    for (const f of this.faults.filter((f) => f.call === call)) t = applyAsrFault(t, f);
    return { ...t, costUsd: 0 };
  }
}

// --- Image ---

/** Prompt → stable "rrggbb", kept mid-bright so frames are never pure black/white. */
export function promptColor(prompt: string): string {
  const h = createHash("sha256").update(prompt).digest();
  return [h[0]!, h[1]!, h[2]!].map((b) => (64 + (b % 160)).toString(16).padStart(2, "0")).join("");
}

export class MockImage implements ImageProvider {
  readonly name = "mock-image";
  readonly calls: ImageRequest[] = [];
  async generate(req: ImageRequest): Promise<{ path: string; costUsd: number }> {
    this.calls.push(req);
    const { prompt, refs, out, variant } = req;
    for (const r of refs ?? []) await access(r); // catches wiring bugs a real API would also reject
    await run(colorImageArgs({ out, hex: promptColor(variant ? `${prompt}#${variant}` : prompt) }));
    return { path: out, costUsd: 0 };
  }
}

// --- Video ---

export interface VideoFault {
  call: number;
  /** Say this instead of the requested line. */
  say?: string;
  /** Throw PolicyRejectedError with this detail (like Seedance's real-face filter). */
  reject?: string;
}

export class MockVideo implements VideoProvider {
  readonly name = "mock-video";
  readonly capabilities: VideoCapabilities;
  readonly calls: AnimateRequest[] = [];
  private readonly faults: VideoFault[];

  constructor(opts: { nativeSpeech?: boolean; durations?: number[]; faults?: VideoFault[] } = {}) {
    this.capabilities = {
      nativeSpeech: opts.nativeSpeech ?? true,
      durations: opts.durations ?? Array.from({ length: 12 }, (_, i) => i + 4), // 4–15, like Seedance 2.0
    };
    this.faults = opts.faults ?? [];
  }

  async animate(req: AnimateRequest): Promise<AnimateResult> {
    const { image, seconds, out, line, refs } = req;
    const call = this.calls.push(req) - 1;
    if (!this.capabilities.durations.includes(seconds)) {
      throw new RangeError(`MockVideo: ${seconds} s not in durations [${this.capabilities.durations.join(", ")}]`);
    }
    await access(image);
    for (const r of refs ?? []) await access(r);
    const fault = this.faults.find((f) => f.call === call);
    if (fault?.reject !== undefined) throw new PolicyRejectedError(this.name, fault.reject);
    const said = fault?.say ?? line ?? "";
    const speaks = this.capabilities.nativeSpeech && words(said).length > 0;
    if (!speaks) {
      await run(stillVideoArgs({ image, out, seconds }));
      return { path: out, seconds, hasAudio: false, costUsd: 0 };
    }
    await withTmp(async (dir) => {
      const still = join(dir, "still.mp4");
      const voice = join(dir, "voice.wav");
      await run(stillVideoArgs({ image, out: still, seconds }));
      await run(toneArgs({ out: voice, seconds: mockSpeechSeconds(said) }));
      await run(muxArgs({ video: still, audio: voice, out, seconds, offset: MOCK_SPEECH_OFFSET }));
    });
    // Words that would start after the clip ends are cut off, as a real model's would be.
    await writeTranscript(out, mockTranscript(said, MOCK_SPEECH_OFFSET, seconds));
    return { path: out, seconds, hasAudio: true, costUsd: 0 };
  }
}

// --- Judge ---

/**
 * One scripted judge reply: a score (issues are made up from it), a full verdict, or `{ raw }`, which goes
 * through the same schema check as a live reply, so a bad shape becomes a JudgeOutputError.
 */
export type JudgeScript = number | { score: number; issues: string[] } | { raw: unknown };

/** Score the mock gives once its script runs out: passes both default bars (keyframe 7, clip 5). */
export const MOCK_JUDGE_SCORE = 8;

export class MockJudge implements JudgeProvider {
  readonly name = "mock-judge";
  readonly calls: ({ kind: "image" } & JudgeImageRequest | { kind: "video" } & JudgeVideoRequest)[] = [];
  private readonly scripts: { image: JudgeScript[]; video: JudgeScript[] };
  private readonly fallback: number;

  constructor(opts: { image?: JudgeScript[]; video?: JudgeScript[]; fallback?: number } = {}) {
    this.scripts = { image: [...(opts.image ?? [])], video: [...(opts.video ?? [])] };
    this.fallback = opts.fallback ?? MOCK_JUDGE_SCORE;
  }

  async judgeImage(req: JudgeImageRequest): Promise<JudgeResult> {
    this.calls.push({ kind: "image", ...req });
    for (const p of [req.path, ...(req.refs ?? [])]) await access(p);
    return this.reply(this.scripts.image.shift());
  }

  async judgeVideo(req: JudgeVideoRequest): Promise<JudgeResult> {
    this.calls.push({ kind: "video", ...req });
    for (const p of [...req.frames, ...(req.refs ?? [])]) await access(p);
    return this.reply(this.scripts.video.shift());
  }

  private reply(s: JudgeScript | undefined): JudgeResult {
    const script = s ?? this.fallback;
    const raw =
      typeof script === "number"
        ? { score: script, issues: script >= 7 ? [] : [`mock issue at score ${script}: hands malformed, face too small`] }
        : "raw" in script
          ? script.raw
          : script;
    // JSON round-trip like a model's text reply.
    const verdict = parseVerdict(this.name, JSON.parse(JSON.stringify(raw ?? null)) as unknown, 0);
    return { ...verdict, costUsd: 0 };
  }
}

// --- Lipsync / Talking ---

/**
 * The output speaks whatever the audio speaks. Resolve through source links (as MockAsr does) instead of
 * copying the raw sidecar: audio muxed outside a mock carries only a `.source.json`, and audio with no
 * sidecar at all is silence, which must stay silence rather than throw ENOENT.
 */
async function carryTranscript(audio: string, out: string): Promise<void> {
  const t = await readTranscript(audio);
  if (t) await writeTranscript(out, t);
}

export class MockLipsync implements LipsyncProvider {
  readonly name = "mock-lipsync";
  readonly calls: { video: string; audio: string; out: string }[] = [];
  readonly maxSeconds: number;
  constructor(opts: { maxSeconds?: number } = {}) {
    this.maxSeconds = opts.maxSeconds ?? Infinity;
  }
  async sync(req: { video: string; audio: string; out: string }) {
    this.calls.push(req);
    const { video, audio, out } = req;
    const { seconds } = await probe(video);
    // Reject an over-long input like a real API would (Kling: 2–10 s); 50 ms covers frame rounding.
    if (seconds > this.maxSeconds + 0.05) {
      throw new Error(`MockLipsync: input video ${seconds} s exceeds max ${this.maxSeconds} s`);
    }
    await run(muxArgs({ video, audio, out, seconds }));
    await carryTranscript(audio, out);
    return { path: out, costUsd: 0 };
  }
}

export class MockTalking implements TalkingProvider {
  readonly name = "mock-talking";
  async talk({ image, audio, out }: { image: string; audio: string; prompt: string; out: string }) {
    const { seconds } = await probe(audio);
    await withTmp(async (dir) => {
      const still = join(dir, "still.mp4");
      await run(stillVideoArgs({ image, out: still, seconds }));
      await run(muxArgs({ video: still, audio, out, seconds }));
    });
    await carryTranscript(audio, out);
    return { path: out, costUsd: 0 };
  }
}
