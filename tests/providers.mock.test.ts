import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { probe, run } from "../src/media/ffmpeg.ts";
import { muxArgs } from "../src/media/args.ts";
import {
  createProviders,
  MockAsr,
  MockImage,
  MockLipsync,
  MockLlm,
  MockTalking,
  MockTts,
  MockVideo,
  NotConfiguredError,
} from "../src/providers/index.ts";
import { mockSpeechSeconds, promptColor } from "../src/providers/mock.ts";
import { linkSource } from "../src/util/sidecar.ts";

const FRAME = 1 / 30;
const LINE = "I kept the watch. I kept everything.";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "itv-mocks-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TTS → ASR (acceptance 1)", () => {
  it("round-trips the exact text", async () => {
    const out = join(dir, "voice.wav");
    const r = await new MockTts().speak({ text: LINE, voice: "any", out });
    expect(r).toEqual({ path: out, seconds: mockSpeechSeconds(LINE), costUsd: 0 });
    expect(r.seconds).toBeCloseTo(7 * 0.38 + 0.3, 3);
    const p = await probe(out);
    expect(p.hasAudio).toBe(true);
    expect(Math.abs(p.seconds - r.seconds)).toBeLessThan(0.02);

    const t = await new MockAsr().transcribe({ path: out });
    expect(t.text).toBe(LINE);
    expect(t.words).toHaveLength(7);
    expect(t.costUsd).toBe(0);
    for (const w of t.words) expect(w.end).toBeLessThanOrEqual(r.seconds);
  });

  it("returns altered text on the faulted call only", async () => {
    const out = join(dir, "voice-f.wav");
    await new MockTts().speak({ text: LINE, voice: "any", out });
    const asr = new MockAsr({ faults: [{ call: 0, drop: 1 }, { call: 1, replace: { watch: "watches" } }, { call: 2, text: "something else" }] });
    expect((await asr.transcribe({ path: out })).text).toBe("I kept the watch. I kept");
    expect((await asr.transcribe({ path: out })).text).toBe("I kept the watches I kept everything.");
    expect((await asr.transcribe({ path: out })).text).toBe("something else");
    expect((await asr.transcribe({ path: out })).text).toBe(LINE);
  });

  it("follows a source link left by code that muxed the speech elsewhere; empty when nothing was said", async () => {
    const voice = join(dir, "v2.wav");
    await new MockTts().speak({ text: "Meet me where it started.", voice: "x", out: voice });
    const img = (await new MockImage().generate({ prompt: "p", out: join(dir, "p.png") })).path;
    const clip = (await new MockVideo({ nativeSpeech: false }).animate({ image: img, prompt: "p", seconds: 4, out: join(dir, "s.mp4") })).path;
    const muxed = join(dir, "muxed.mp4");
    await run(muxArgs({ video: clip, audio: voice, out: muxed, seconds: 4 }));
    const asr = new MockAsr();
    expect((await asr.transcribe({ path: muxed })).text).toBe("");
    await linkSource(muxed, voice);
    expect((await asr.transcribe({ path: muxed })).text).toBe("Meet me where it started.");
    await expect(asr.transcribe({ path: join(dir, "nope.wav") })).rejects.toThrow();
  });
});

describe("image / video / lipsync / talking (acceptance 2)", () => {
  it("image: 1080×1920 PNG, colour stable per prompt", async () => {
    const r = await new MockImage().generate({ prompt: "rooftop at dusk", out: join(dir, "a.png") });
    expect(r.costUsd).toBe(0);
    expect(await probe(r.path)).toMatchObject({ width: 1080, height: 1920, hasVideo: true });
    expect(promptColor("rooftop at dusk")).toBe(promptColor("rooftop at dusk"));
    expect(promptColor("rooftop at dusk")).not.toBe(promptColor("rooftop at dawn"));
    await expect(new MockImage().generate({ prompt: "x", refs: [join(dir, "missing.png")], out: join(dir, "b.png") })).rejects.toThrow();
  });

  it("video: silent still clip of requested seconds; native speech adds audio + transcript; faults paraphrase", async () => {
    const img = (await new MockImage().generate({ prompt: "face", out: join(dir, "face.png") })).path;

    const silent = await new MockVideo({ nativeSpeech: false }).animate({ image: img, prompt: "p", seconds: 5, out: join(dir, "silent.mp4"), line: LINE });
    expect(silent).toMatchObject({ seconds: 5, hasAudio: false, costUsd: 0 });
    const ps = await probe(silent.path);
    expect(ps).toMatchObject({ width: 1080, height: 1920, hasAudio: false });
    expect(Math.abs(ps.seconds - 5)).toBeLessThanOrEqual(FRAME);

    const video = new MockVideo({ faults: [{ call: 1, say: "a paraphrase" }] });
    expect(video.capabilities).toEqual({ nativeSpeech: true, durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
    const talk = await video.animate({ image: img, prompt: "p", seconds: 4, out: join(dir, "talk.mp4"), line: "Meet me where it started." });
    expect(talk.hasAudio).toBe(true);
    const pt = await probe(talk.path);
    expect(pt).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(Math.abs(pt.seconds - 4)).toBeLessThanOrEqual(FRAME);
    const asr = new MockAsr();
    expect((await asr.transcribe({ path: talk.path })).text).toBe("Meet me where it started.");

    const para = await video.animate({ image: img, prompt: "p", seconds: 4, out: join(dir, "para.mp4"), line: "Meet me where it started." });
    expect((await asr.transcribe({ path: para.path })).text).toBe("a paraphrase");

    await expect(video.animate({ image: img, prompt: "p", seconds: 3, out: join(dir, "bad.mp4") })).rejects.toThrow(RangeError);
  }, 60_000);

  it("video: speech longer than the clip is cut off in the transcript", async () => {
    const img = (await new MockImage().generate({ prompt: "f", out: join(dir, "f.png") })).path;
    const long = "one two three four five six seven eight nine ten eleven twelve";
    const r = await new MockVideo().animate({ image: img, prompt: "p", seconds: 4, out: join(dir, "long.mp4"), line: long });
    const t = await new MockAsr().transcribe({ path: r.path });
    expect(t.words.length).toBeLessThan(12);
    expect(t.words.every((w) => w.start < 4)).toBe(true);
  }, 30_000);

  it("lipsync: audio present, video length kept, transcript of the audio; talking: clip of audio length", async () => {
    const img = (await new MockImage().generate({ prompt: "g", out: join(dir, "g.png") })).path;
    const clip = await new MockVideo({ nativeSpeech: false }).animate({ image: img, prompt: "p", seconds: 6, out: join(dir, "clip.mp4") });
    const voice = await new MockTts().speak({ text: LINE, voice: "v", out: join(dir, "line.wav") });

    const synced = await new MockLipsync().sync({ video: clip.path, audio: voice.path, out: join(dir, "synced.mp4") });
    const ps = await probe(synced.path);
    expect(ps).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(Math.abs(ps.seconds - 6)).toBeLessThanOrEqual(FRAME);
    expect((await new MockAsr().transcribe({ path: synced.path })).text).toBe(LINE);

    const talking = await new MockTalking().talk({ image: img, audio: voice.path, prompt: "p", out: join(dir, "talking.mp4") });
    const pk = await probe(talking.path);
    expect(pk).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(Math.abs(pk.seconds - voice.seconds)).toBeLessThanOrEqual(FRAME + 0.02);
    expect((await new MockAsr().transcribe({ path: talking.path })).text).toBe(LINE);
  }, 60_000);

  it("lipsync/talking accept audio with only a source link, or no sidecar at all (silence)", async () => {
    const img = (await new MockImage().generate({ prompt: "l", out: join(dir, "l.png") })).path;
    const clip = await new MockVideo({ nativeSpeech: false }).animate({ image: img, prompt: "p", seconds: 4, out: join(dir, "lclip.mp4") });
    const voice = await new MockTts().speak({ text: LINE, voice: "v", out: join(dir, "lvoice.wav") });
    // Audio produced outside a mock (e.g. a concat) that only links back to the TTS file.
    const linked = join(dir, "linked.wav");
    await run(["-i", voice.path, "-c", "copy", linked]);
    await linkSource(linked, voice.path);
    const asr = new MockAsr();

    const synced = await new MockLipsync().sync({ video: clip.path, audio: linked, out: join(dir, "lsynced.mp4") });
    expect((await asr.transcribe({ path: synced.path })).text).toBe(LINE);
    const talking = await new MockTalking().talk({ image: img, audio: linked, prompt: "p", out: join(dir, "ltalk.mp4") });
    expect((await asr.transcribe({ path: talking.path })).text).toBe(LINE);

    // No sidecar anywhere: the output is silent to the ASR, not an ENOENT.
    const bare = join(dir, "bare.wav");
    await run(["-i", voice.path, "-c", "copy", bare]);
    const silentSync = await new MockLipsync().sync({ video: clip.path, audio: bare, out: join(dir, "bsynced.mp4") });
    expect((await asr.transcribe({ path: silentSync.path })).text).toBe("");
    const silentTalk = await new MockTalking().talk({ image: img, audio: bare, prompt: "p", out: join(dir, "btalk.mp4") });
    expect((await asr.transcribe({ path: silentTalk.path })).text).toBe("");
  }, 60_000);
});

describe("MockLlm", () => {
  const Shape = z.object({ title: z.string(), n: z.number() });

  it("serves a queue, parses through the schema, reports errors without throwing", async () => {
    const llm = new MockLlm({ queue: [{ title: "x", n: 1 }, { title: 3 }] });
    const ok = await llm.generateJson({ system: "s", prompt: "p1", schema: Shape });
    // meta.usage: ~4 chars per token of system+prompt ("sp1") and of the JSON reply (F17: mock traces carry usage).
    expect(ok).toEqual({ ok: true, data: { title: "x", n: 1 }, raw: { title: "x", n: 1 }, costUsd: 0, meta: { usage: { input: 1, output: 5 } } });
    const bad = await llm.generateJson({ system: "s", prompt: "p2", schema: Shape });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/title/);
    await expect(llm.generateJson({ system: "s", prompt: "p3", schema: Shape })).rejects.toThrow(/no canned response/);
    expect(llm.calls.map((c) => c.prompt)).toEqual(["p1", "p2", "p3"]);
  });

  it("uses a responder with the call index", async () => {
    const llm = new MockLlm({ responder: (prompt, { call }) => ({ title: prompt, n: call }) });
    await llm.generateJson({ system: "s", prompt: "a", schema: Shape });
    const r = await llm.generateJson({ system: "s", prompt: "b", schema: Shape, temperature: 0.2 });
    expect(r.ok && r.data).toEqual({ title: "b", n: 1 });
    expect(llm.calls[1]).toEqual({ system: "s", prompt: "b", temperature: 0.2 });
  });
});

describe("createProviders", () => {
  it("mock mode returns every capability, overridable", () => {
    const asr = new MockAsr({ faults: [{ call: 0, drop: 1 }] });
    const p = createProviders({ mode: "mock", env: {}, overrides: { asr } });
    expect(Object.keys(p).sort()).toEqual(["asr", "image", "judge", "lipsync", "llm", "talking", "tts", "video"]);
    expect(p.asr).toBe(asr);
    expect(p.tts).toBeInstanceOf(MockTts);
  });

  it("live mode throws NotConfiguredError naming the missing env var", () => {
    try {
      createProviders({ mode: "live", env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NotConfiguredError);
      expect((e as NotConfiguredError).envVar).toBe("GEMINI_API_KEY");
      expect((e as Error).message).toContain("GEMINI_API_KEY");
    }
    expect(() => createProviders({ mode: "live", env: { GEMINI_API_KEY: "x" } })).toThrow(/GROQ_API_KEY/);
  });

  it("mock outputs are files on disk", async () => {
    const p = createProviders({ mode: "mock", env: {} });
    const r = await p.image.generate({ prompt: "x", out: join(dir, "reg.png") });
    await expect(access(r.path)).resolves.toBeUndefined();
  });
});
