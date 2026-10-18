import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the real compareWords so we can assert what the gate is asked to compare (acceptance 4).
vi.mock("../src/verbatim.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/verbatim.ts")>();
  return { ...mod, compareWords: vi.fn(mod.compareWords) };
});

import { compareWords, splitDelivery } from "../src/verbatim.ts";
import { describeOps, listen, speechWindow, VerbatimError } from "../src/nodes/gate.ts";
import { verifiedVoice, voiceKey } from "../src/nodes/voice.ts";
import {
  createProviders,
  ElevenLabsTts,
  GeminiTts,
  GroqAsr,
  HttpError,
  MockAsr,
  MockImage,
  MockTts,
  MockVideo,
  NotConfiguredError,
  TtsChain,
  ttsFromEnv,
  type FetchLike,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from "../src/providers/index.ts";
import { pcmToWav, wavSeconds } from "../src/providers/http.ts";
import { GEMINI_INTERACTIONS_URL } from "../src/providers/gemini-tts.ts";
import { GROQ_ASR_URL } from "../src/providers/groq-asr.ts";
import { extractAudioArgs } from "../src/media/args.ts";
import { Attempt, type Character } from "../src/schemas.ts";

const LINE = "I kept the watch. I kept everything.";
const CHARACTER: Character = {
  name: "Dan",
  look: "late thirties, short dark beard, grey hoodie, tired eyes, rooftop at dusk behind him",
  voice: { gender: "male", age: "adult", tone: "low, steady" },
  voiceDescription: "low, steady male voice, late thirties, neutral American accent, unhurried",
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "itv-voice-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(compareWords).mockClear();
});

/** Counts speak() calls and records each request. */
class CountingTts implements TtsProvider {
  readonly name = "counting-mock-tts";
  readonly requests: TtsRequest[] = [];
  private readonly inner = new MockTts();
  speak(req: TtsRequest): Promise<TtsResult> {
    this.requests.push(req);
    return this.inner.speak(req);
  }
}

const sub = (name: string) => mkdtemp(join(dir, `${name}-`));

describe("listen (acceptance 1)", () => {
  it("fails a paraphrase spoken in a mock clip with the right op", async () => {
    const d = await sub("listen-para");
    const image = (await new MockImage().generate({ prompt: "rooftop", out: join(d, "k.png") })).path;
    const video = new MockVideo({ faults: [{ call: 0, say: "I kept the clock. I kept everything." }] });
    const clip = await video.animate({ image, prompt: "talks", seconds: 5, out: join(d, "clip.mp4"), line: LINE });
    const r = await listen(clip.path, LINE, { asr: new MockAsr() });
    expect(r.pass).toBe(false);
    expect(r.wer).toBeCloseTo(1 / 7);
    expect(r.ops).toEqual([{ type: "sub", expected: "watch", heard: "clock" }]);
  });

  it("passes the exact line with a speech window 0 <= start < end", async () => {
    const d = await sub("listen-exact");
    const image = (await new MockImage().generate({ prompt: "rooftop", out: join(d, "k.png") })).path;
    const clip = await new MockVideo().animate({ image, prompt: "talks", seconds: 5, out: join(d, "clip.mp4"), line: LINE });
    const r = await listen(clip.path, LINE, { asr: new MockAsr() });
    expect(r.pass).toBe(true);
    expect(r.wer).toBe(0);
    expect(r.speechStart).toBeGreaterThanOrEqual(0);
    expect(r.speechStart).toBeLessThan(r.speechEnd);
    expect(r.speechEnd).toBeLessThanOrEqual(5);
  });

  it("speechWindow spans first start to last end; empty → 0,0", () => {
    expect(speechWindow([{ word: "a", start: 0.4, end: 0.7 }, { word: "b", start: 0.8, end: 1.2 }])).toEqual({
      speechStart: 0.4,
      speechEnd: 1.2,
    });
    expect(speechWindow([])).toEqual({ speechStart: 0, speechEnd: 0 });
  });
});

describe("verifiedVoice", () => {
  it("retries after ASR drops a word, then passes (acceptance 2)", async () => {
    const tts = new CountingTts();
    const asr = new MockAsr({ faults: [{ call: 0, drop: 1 }] });
    const v = await verifiedVoice(LINE, CHARACTER, { tts, asr, dir: await sub("retry") });
    expect(tts.requests.map((r) => r.variant)).toEqual([0, 1]);
    expect(v.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(v.attempts[0]!.reason).toContain(`del "everything"`);
    expect(v.attempts[1]!.reason).toBeUndefined();
    for (const a of v.attempts) expect(Attempt.safeParse(a).success).toBe(true);
    expect(v.attempts.every((a) => a.stage === "voice")).toBe(true);
    expect(v.verbatim.pass).toBe(true);
    expect(v.seconds).toBeGreaterThan(0);
    expect(v.speechStart).toBeGreaterThanOrEqual(0);
    expect(v.speechStart).toBeLessThan(v.speechEnd);
    expect(v.path).toMatch(/voice-[0-9a-f]{16}\.wav$/);
    expect(tts.requests[0]!.voice).toBe("male-adult");
  });

  it("throws VerbatimError after exactly maxAttempts TTS calls when ASR is always wrong (acceptance 3)", async () => {
    const tts = new CountingTts();
    const asr = new MockAsr({ faults: [0, 1, 2, 3].map((call) => ({ call, replace: { watch: "wash" } })) });
    const err = await verifiedVoice(LINE, CHARACTER, { tts, asr, dir: await sub("fail"), maxAttempts: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(VerbatimError);
    const ve = err as VerbatimError;
    expect(ve.result.wer).toBeGreaterThan(0);
    expect(ve.result.ops).toEqual([{ type: "sub", expected: "watch", heard: "wash" }]);
    expect(tts.requests).toHaveLength(3);
    expect(ve.attempts.map((a) => a.ok)).toEqual([false, false, false]);
    expect(ve.attempts.map((a) => a.n)).toEqual([1, 2, 3]);
  });

  it("never lets an emotion tag reach compareWords as expected text (acceptance 4)", async () => {
    const tts = new CountingTts();
    const v = await verifiedVoice(`[whispers] ${LINE}`, CHARACTER, {
      tts,
      asr: new MockAsr(),
      dir: await sub("tags"),
      emotion: "hopeful disbelief",
    });
    expect(v.verbatim.pass).toBe(true);
    const expectedArgs = vi.mocked(compareWords).mock.calls.map(([expected]) => expected);
    expect(expectedArgs.length).toBeGreaterThan(0);
    for (const e of expectedArgs) {
      expect(e).not.toMatch(/whisper|disbelief|\[|\]/i);
      expect(e).toBe(LINE);
    }
    // The tag still reaches the provider, as delivery.
    expect(tts.requests[0]!.text).toBe(LINE);
    expect(tts.requests[0]!.emotion).toBe("hopeful disbelief, whispers");
  });

  it("listen strips tags from the expected text too", async () => {
    const d = await sub("listen-tag");
    const take = await new MockTts().speak({ text: LINE, voice: "x", out: join(d, "a.wav") });
    const r = await listen(take.path, `<sigh> ${LINE} [laughs]`, { asr: new MockAsr() });
    expect(r.pass).toBe(true);
    expect(vi.mocked(compareWords).mock.calls.at(-1)![0]).toBe(LINE);
  });

  it("F10: a laugh tag lets heard laughter through, and the voice attempt logs what was ignored", async () => {
    const d = await sub("laugh");
    // One extra mock word only: the mock tone is sized for the line, and the speech window must stay inside it.
    const asr = new MockAsr({ faults: [{ call: 0, text: `${LINE} Haha.` }] });
    const v = await verifiedVoice(`${LINE} [laughs]`, CHARACTER, { tts: new MockTts(), asr, dir: d });
    expect(v.verbatim.pass).toBe(true);
    expect(v.verbatim.ignored).toEqual(["haha"]);
    expect(v.attempts[0]!.reason).toMatch(/ignored non-speech: haha/);
    const tagged = await listen(v.path, `${LINE} [laughs]`, { asr: new MockAsr({ faults: [{ call: 0, text: `(laughs) ${LINE} Ha ha.` }] }) });
    expect([tagged.pass, tagged.ignored]).toEqual([true, ["(laughs)", "ha", "ha"]]);
    // Without the tag the same audio fails: laughter is then an inserted word.
    const strict = await listen(v.path, LINE, { asr: new MockAsr({ faults: [{ call: 0, text: `${LINE} Ha ha.` }] }) });
    expect(strict.pass).toBe(false);
  });

  it("F10: mock ASR hears only speakable words, so an emoji left in expected text fails like a live run", async () => {
    const d = await sub("emoji");
    const take = await new MockTts().speak({ text: "Go now 🚀 ♥", voice: "x", out: join(d, "a.wav") });
    const heard = await new MockAsr().transcribe({ path: take.path });
    expect(heard.text).toBe("Go now");
    expect(compareWords("Go now 🚀", heard.text).pass).toBe(false);
    expect((await listen(take.path, "Go now 🚀", { asr: new MockAsr() })).pass).toBe(true); // the gate drops emoji
  });

  it("is idempotent: a second run reuses the take and calls TTS again for nothing", async () => {
    const d = await sub("resume");
    const tts = new CountingTts();
    const a = await verifiedVoice(LINE, CHARACTER, { tts, asr: new MockAsr(), dir: d });
    const b = await verifiedVoice(LINE, CHARACTER, { tts, asr: new MockAsr(), dir: d });
    expect(b.path).toBe(a.path);
    expect(tts.requests).toHaveLength(1);
    expect(b.attempts[0]!.reason).toMatch(/cached/);
    expect(b.seconds).toBeCloseTo(a.seconds, 1);
  });

  it("records a TTS chain fallback note in the attempt", async () => {
    const failing: TtsProvider = {
      name: "busy",
      speak: () => Promise.reject(new HttpError("busy", 429, "quota")),
    };
    const v = await verifiedVoice(LINE, CHARACTER, {
      tts: new TtsChain([failing, new MockTts()]),
      asr: new MockAsr(),
      dir: await sub("chain"),
    });
    expect(v.attempts[0]!.ok).toBe(true);
    expect(v.attempts[0]!.provider).toBe("mock-tts+mock-asr");
    expect(v.attempts[0]!.reason).toMatch(/busy failed .*429.*fell back to mock-tts/);
  });
});

describe("helpers", () => {
  it("splitDelivery separates [tags] and <tags> from words", () => {
    expect(splitDelivery("[whispers] I kept it. <sigh>")).toEqual({ spoken: "I kept it.", tags: ["whispers", "sigh"] });
    expect(splitDelivery(LINE)).toEqual({ spoken: LINE, tags: [] });
  });

  it("describeOps names each difference", () => {
    expect(
      describeOps([
        { type: "sub", expected: "a", heard: "b" },
        { type: "del", expected: "c" },
        { type: "ins", heard: "d" },
      ]),
    ).toBe(`sub "a" heard as "b", del "c" (missing), ins "d" (extra)`);
  });

  it("voiceKey is gender-age", () => {
    expect(voiceKey(CHARACTER)).toBe("male-adult");
  });

  it("pcmToWav writes a header wavSeconds can read; RIFF passes through", () => {
    const wav = pcmToWav(new Uint8Array(48000), 24000); // 1 s of 16-bit mono at 24 kHz
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wavSeconds(wav)).toBe(1);
    expect(pcmToWav(wav, 8000).equals(wav)).toBe(true);
  });

  it("extractAudioArgs pulls the first audio stream as 16 kHz mono flac", () => {
    expect(extractAudioArgs({ input: "in.mp4", out: "o.flac" })).toEqual([
      "-i", "in.mp4", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", "o.flac",
    ]);
  });
});

// --- Live adapters against a fake fetch (acceptance 5): no network ---

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
  };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

describe("GroqAsr", () => {
  it("posts the documented multipart request and maps verbose_json words", async () => {
    const d = await sub("groq");
    const audio = join(d, "take.wav");
    await writeFile(audio, pcmToWav(new Uint8Array(4800), 24000));
    const f = fakeFetch(() =>
      json({
        text: " I kept the watch.",
        duration: 1.2,
        words: [
          { word: " I", start: 0.1, end: 0.2 },
          { word: "kept", start: 0.25, end: 0.5 },
          { word: "the", start: 0.5, end: 0.6 },
          { word: "watch.", start: 0.6, end: 1.0 },
        ],
      }),
    );
    const asr = GroqAsr.fromEnv({ GROQ_API_KEY: "gk" }, { fetch: f.fetch });
    const r = await asr.transcribe({ path: audio });

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(url).toBe(GROQ_ASR_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer gk" });
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word"]);
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBeNull(); // never prime the ASR with the expected line
    const file = form.get("file") as File;
    expect(file.name).toBe("take.wav");
    expect(file.size).toBe(44 + 4800);

    expect(r.text).toBe("I kept the watch.");
    expect(r.words[0]).toEqual({ word: "I", start: 0.1, end: 0.2 });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("uses GROQ_ASR_MODEL and extracts audio from video files first", async () => {
    const d = await sub("groq-video");
    const f = fakeFetch(() => json({ text: "hi", words: [{ word: "hi", start: 0, end: 0.3 }] }));
    const extracted: string[] = [];
    const asr = GroqAsr.fromEnv(
      { GROQ_API_KEY: "gk", GROQ_ASR_MODEL: "whisper-large-v3-turbo" },
      {
        fetch: f.fetch,
        extract: async (input, out) => {
          extracted.push(input);
          await writeFile(out, "flac-bytes");
        },
      },
    );
    await asr.transcribe({ path: join(d, "clip.mp4") });
    expect(extracted).toEqual([join(d, "clip.mp4")]);
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect((form.get("file") as File).name).toBe("clip.flac");
  });

  it("throws HttpError with the status on a failed request; needs GROQ_API_KEY", async () => {
    const d = await sub("groq-err");
    await writeFile(join(d, "a.wav"), pcmToWav(new Uint8Array(10), 24000));
    const f = fakeFetch(() => new Response("rate limited", { status: 429 }));
    const err = await new GroqAsr({ apiKey: "k", fetch: f.fetch }).transcribe({ path: join(d, "a.wav") }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect(() => GroqAsr.fromEnv({})).toThrow(/GROQ_API_KEY/);
  });
});

describe("GeminiTts", () => {
  it("posts the documented interactions body and writes the returned WAV", async () => {
    const d = await sub("gemini");
    const audio = pcmToWav(new Uint8Array(24000), 24000); // 0.5 s
    const f = fakeFetch(() =>
      json({
        steps: [
          { type: "user_input", content: [{ type: "text" }] },
          { type: "model_output", content: [{ type: "audio", data: audio.toString("base64") }] },
        ],
      }),
    );
    const tts = GeminiTts.fromEnv({ GEMINI_API_KEY: "gem" }, { fetch: f.fetch });
    const out = join(d, "g.wav");
    const r = await tts.speak({ text: LINE, voice: "female-adult", out, emotion: "whispers", variant: 2 });

    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(url).toBe(GEMINI_INTERACTIONS_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-goog-api-key": "gem", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gemini-3.8-flash-tts",
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text: LINE, annotations: [{ type: "speech_metadata", style: "whispers" }] }],
        },
      ],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
    expect(r.path).toBe(out);
    expect(r.seconds).toBe(0.5);
    expect((await readFile(out)).equals(audio)).toBe(true);
  });

  it("wraps raw PCM, honours GEMINI_TTS_MODEL / GEMINI_TTS_VOICES, omits annotations without emotion", async () => {
    const d = await sub("gemini-pcm");
    const f = fakeFetch(() =>
      json({ steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.alloc(48000).toString("base64") }] }] }),
    );
    const tts = GeminiTts.fromEnv(
      { GEMINI_API_KEY: "gem", GEMINI_TTS_MODEL: "gemini-3.8-flash-lite-tts", GEMINI_TTS_VOICES: '{"male-adult":"Orus"}' },
      { fetch: f.fetch },
    );
    const r = await tts.speak({ text: "Hi.", voice: "male-adult", out: join(d, "p.wav") });
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.model).toBe("gemini-3.8-flash-lite-tts");
    expect(body.generation_config.speech_config).toEqual([{ voice: "Orus" }]);
    expect(body.input[0].content[0]).toEqual({ type: "text", text: "Hi." });
    expect(r.seconds).toBe(1);
  });

  it("fails loudly when the response has no audio", async () => {
    const f = fakeFetch(() => json({ steps: [{ type: "model_output", content: [{ type: "text" }] }] }));
    const tts = new GeminiTts({ apiKey: "k", fetch: f.fetch });
    await expect(tts.speak({ text: "x", voice: "Kore", out: join(dir, "none.wav") })).rejects.toThrow(/no audio/);
  });
});

describe("ElevenLabsTts", () => {
  it("posts eleven_v3 with the emotion as an audio-tag prefix and a per-variant seed", async () => {
    const d = await sub("eleven");
    const f = fakeFetch(() => new Response(new Uint8Array(24000), { status: 200 })); // 0.5 s raw PCM
    const tts = ElevenLabsTts.fromEnv(
      { ELEVENLABS_API_KEY: "el", ELEVENLABS_VOICES: '{"male-adult":"VOICE123"}' },
      { fetch: f.fetch },
    );
    const r = await tts.speak({ text: LINE, voice: "male-adult", out: join(d, "e.wav"), emotion: "whispers", variant: 2 });

    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/VOICE123?output_format=pcm_24000");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "xi-api-key": "el", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ text: `[whispers] ${LINE}`, model_id: "eleven_v3", seed: 2 });
    expect(r.seconds).toBe(0.5);
    expect(r.costUsd).toBeCloseTo(((`[whispers] ${LINE}`).length * 0.08) / 1000, 8);
    expect((await readFile(join(d, "e.wav"))).subarray(0, 4).toString()).toBe("RIFF");
  });

  it("uses the default voice table and no tag without emotion", () => {
    const tts = new ElevenLabsTts({ apiKey: "el" });
    expect(tts.url("female-adult")).toMatch(/text-to-speech\/21m00Tcm4TlvDq8ikWAM\?/);
    expect(tts.body({ text: "Hi." })).toEqual({ text: "Hi.", model_id: "eleven_v3", seed: 0 });
  });
});

describe("TTS order from env", () => {
  it("defaults to gemini,elevenlabs and skips a provider without a key", () => {
    expect(ttsFromEnv({ GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" }).providers.map((p) => p.name)).toEqual([
      "gemini-tts",
      "elevenlabs",
    ]);
    expect(ttsFromEnv({ ELEVENLABS_API_KEY: "e" }).providers.map((p) => p.name)).toEqual(["elevenlabs"]);
    expect(
      ttsFromEnv({ TTS_PROVIDERS: "elevenlabs, gemini", GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" }).providers.map(
        (p) => p.name,
      ),
    ).toEqual(["elevenlabs", "gemini-tts"]);
  });

  it("names every key when none is set and rejects unknown providers", () => {
    expect(() => ttsFromEnv({})).toThrow(NotConfiguredError);
    expect(() => ttsFromEnv({})).toThrow(/GEMINI_API_KEY or ELEVENLABS_API_KEY/);
    expect(() => ttsFromEnv({ TTS_PROVIDERS: "gemini,acme", GEMINI_API_KEY: "g" })).toThrow(/acme/);
  });

  it("chain falls through on 429 with a note, but rethrows a non-transient error", async () => {
    const busy: TtsProvider = { name: "busy", speak: () => Promise.reject(new HttpError("busy", 503, "down")) };
    const bad: TtsProvider = { name: "bad", speak: () => Promise.reject(new HttpError("bad", 400, "invalid voice")) };
    const ok: TtsProvider = { name: "ok", speak: async (r) => ({ path: r.out, seconds: 1, costUsd: 0 }) };
    const r = await new TtsChain([busy, ok]).speak({ text: "x", voice: "v", out: "o.wav" });
    expect(r.provider).toBe("ok");
    expect(r.notes).toEqual([expect.stringMatching(/busy failed .*503.*fell back to ok/)]);
    await expect(new TtsChain([bad, ok]).speak({ text: "x", voice: "v", out: "o.wav" })).rejects.toThrow(/400/);
  });

  it("createProviders live wires the TTS chain and Groq ASR without making a request", () => {
    const { tts: _t, asr: _a, llm: _l, ...rest } = createProviders({ mode: "mock", env: {} });
    const p = createProviders({
      mode: "live",
      env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "q", FAL_KEY: "f" },
      overrides: rest,
    });
    expect(p.tts).toBeInstanceOf(TtsChain);
    expect(p.asr).toBeInstanceOf(GroqAsr);
  });
});
