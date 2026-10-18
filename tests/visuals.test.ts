import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ValidationError } from "@fal-ai/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  castCharacter,
  keyframePrompt,
  keyframeShot,
  ShotError,
  snapDuration,
  talkingPrompt,
  talkingShot,
} from "../src/nodes/visuals.ts";
import { VerbatimError } from "../src/nodes/gate.ts";
import { muxArgs, trimArgs } from "../src/media/args.ts";
import { probe, run } from "../src/media/ffmpeg.ts";
import {
  BytePlusSeedance,
  CommandLipsync,
  createProviders,
  FalKlingLipsync,
  FalNanoBananaImage,
  FalSeedance,
  GeminiImage,
  HttpError,
  imageFromEnv,
  lipsyncFromEnv,
  lipsyncOrDeferred,
  MockAsr,
  MockImage,
  MockLipsync,
  MockTalking,
  MockTts,
  MockVideo,
  NotConfiguredError,
  OpenRouterImage,
  OpenRouterSeedance,
  PolicyRejectedError,
  SEEDANCE_DURATIONS,
  SeedanceVideo,
  seedanceFromEnv,
  SeedreamImage,
  type FalLike,
  type FetchLike,
} from "../src/providers/index.ts";
import { commandArgv, klingLipsyncCost } from "../src/providers/lipsync.ts";
import { Attempt, Script, type Shot } from "../src/schemas.ts";

const LINE = "I kept the watch. I kept everything.";

const SCRIPT: Script = Script.parse({
  promptVersion: "test",
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
      line: LINE,
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
  quotedLines: [LINE],
});
const S1 = SCRIPT.shots[0]!;
const S2 = SCRIPT.shots[1]!;

let root: string;
let n = 0;
/** A fresh run dir per test: artifacts are content-addressed, so a shared dir would hide calls behind the cache. */
const fresh = () => join(root, `run-${++n}`);
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "itv-visuals-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function keyframeFor(dir: string, image = new MockImage()) {
  const portrait = await castCharacter(SCRIPT, { image, dir });
  const kf = await keyframeShot(S1, SCRIPT, portrait.path, undefined, { image, dir });
  return kf.path;
}

function rig(video: MockVideo) {
  const asr = new MockAsr();
  const tts = new MockTts();
  const lipsync = new MockLipsync();
  const transcribe = vi.spyOn(asr, "transcribe");
  return { video, asr, tts, lipsync, transcribe };
}

describe("snapDuration (acceptance 1)", () => {
  it("picks the smallest allowed duration ≥ seconds", () => {
    expect(snapDuration(6.2, SEEDANCE_DURATIONS)).toBe(7);
    expect(snapDuration(4, SEEDANCE_DURATIONS)).toBe(4);
    expect(snapDuration(0.5, SEEDANCE_DURATIONS)).toBe(4);
    expect(snapDuration(15, SEEDANCE_DURATIONS)).toBe(15);
    expect(snapDuration(7, [10, 5, 8])).toBe(8); // order of the list does not matter
  });
  it("throws above the max and on nonsense", () => {
    expect(() => snapDuration(16, SEEDANCE_DURATIONS)).toThrow(/longer than the longest allowed clip \(15 s\)/);
    expect(() => snapDuration(15.01, SEEDANCE_DURATIONS)).toThrow(RangeError);
    expect(() => snapDuration(0, SEEDANCE_DURATIONS)).toThrow(RangeError);
    expect(() => snapDuration(Number.NaN, SEEDANCE_DURATIONS)).toThrow(RangeError);
  });
});

describe("trimArgs", () => {
  it("re-encodes the first N seconds, video only (lip-sync replaces the audio)", () => {
    expect(trimArgs({ input: "in.mp4", out: "out.mp4", seconds: 3.1666 })).toEqual([
      "-i", "in.mp4", "-t", "3.167", "-map", "0:v:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
      "-an", "out.mp4",
    ]);
    expect(() => trimArgs({ input: "a", out: "b", seconds: 0 })).toThrow(RangeError);
  });
});

describe("prompts (acceptance 6)", () => {
  it("keyframePrompt has look, setting, camera, emotion and the fixed style clause", () => {
    const p = keyframePrompt(S1, SCRIPT);
    expect(p).toContain(SCRIPT.character.look);
    expect(p).toContain(SCRIPT.setting);
    expect(p).toContain("medium close-up");
    expect(p).toContain("quiet, hurt");
    expect(p.toLowerCase()).toContain("photoreal, cinematic, vertical 9:16, face clearly visible, mouth closed, no text, no watermark");
  });

  it("talkingPrompt quotes the line verbatim, with quotes and apostrophes intact", () => {
    const line = `He said "don't" twice, and I didn't listen — Dan's fault.`;
    const shot: Shot = { ...S1, line };
    const p = talkingPrompt(shot, SCRIPT);
    expect(p).toContain(`"${line}"`);
    expect(p).toContain("quiet, hurt");
    expect(p).toMatch(/locked-off camera/i);
    expect(p).toMatch(/one speaking face toward the camera/i);
    expect(p).toMatch(/no other speech, no music/i);
  });

  it("talkingPrompt keeps delivery tags out of the quote and in the emotion", () => {
    const p = talkingPrompt({ ...S1, line: "[whispers] I kept the watch." }, SCRIPT);
    expect(p).toContain(`"I kept the watch."`);
    expect(p).not.toContain("[whispers]");
    expect(p).toContain("quiet, hurt, whispers");
  });

  it("silent shot prompt asks for no speech", () => {
    const p = talkingPrompt(S2, SCRIPT);
    expect(p).not.toContain('"');
    expect(p).toMatch(/no speech, no music/i);
  });
});

describe("portrait and keyframes (acceptance 2)", () => {
  it("s2's keyframe gets the portrait and s1's keyframe as refs; s1 only the portrait", async () => {
    const dir = fresh();
    const image = new MockImage();
    const portrait = await castCharacter(SCRIPT, { image, dir });
    const k1 = await keyframeShot(S1, SCRIPT, portrait.path, undefined, { image, dir });
    const k2 = await keyframeShot(S2, SCRIPT, portrait.path, k1.path, { image, dir });

    expect(image.calls).toHaveLength(3);
    expect(image.calls[0]!.refs).toBeUndefined();
    expect(image.calls[0]!.prompt).toMatch(/portrait/i);
    expect(image.calls[0]!.prompt).toMatch(/9:16/);
    expect(image.calls[1]!.refs).toEqual([portrait.path]);
    expect(image.calls[2]!.refs).toEqual([portrait.path, k1.path]);
    expect(image.calls[2]!.prompt).toBe(keyframePrompt(S2, SCRIPT));
    expect(k2.attempts[0]).toMatchObject({ stage: "keyframe", shotId: "s2", ok: true, provider: "mock-image" });
    for (const a of [...portrait.attempts, ...k1.attempts, ...k2.attempts]) Attempt.parse(a);
  });

  it("is idempotent: a resumed run reuses the files and makes no image calls", async () => {
    const dir = fresh();
    await keyframeFor(dir);
    const again = new MockImage();
    const portrait = await castCharacter(SCRIPT, { image: again, dir });
    const k1 = await keyframeShot(S1, SCRIPT, portrait.path, undefined, { image: again, dir });
    expect(again.calls).toHaveLength(0);
    expect(k1.attempts[0]!.reason).toMatch(/reused cached/);
  });
});

describe("talkingShot", () => {
  it("native path: the video says the line → passes after 1 video call, no TTS / lip-sync (acceptance 3)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo());
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, ...r });

    expect(r.video.calls).toHaveLength(1);
    expect(r.video.calls[0]).toMatchObject({ image: kf, seconds: 7, line: LINE, variant: 0 });
    expect(r.video.calls[0]!.prompt).toBe(talkingPrompt(S1, SCRIPT));
    expect(r.tts.calls).toHaveLength(0);
    expect(r.lipsync.calls).toHaveLength(0);
    expect(shot).toMatchObject({ shotId: "s1", via: "native", hasAudio: true, verbatim: { pass: true, wer: 0 } });
    expect(shot.attempts).toHaveLength(1);
    expect(shot.attempts[0]).toMatchObject({ stage: "video", shotId: "s1", n: 1, ok: true });
    expect(shot.speechEnd!).toBeGreaterThan(shot.speechStart!);
  }, 60_000);

  it("native fails twice → exactly maxNative video calls, then TTS + lip-sync, final listen passes (acceptance 4)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const wrong = "I kept the clock. I kept everything.";
    const r = rig(new MockVideo({ faults: [{ call: 0, say: wrong }, { call: 1, say: "I kept it." }] }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(r.video.calls).toHaveLength(2);
    expect(r.video.calls.map((c) => c.variant)).toEqual([0, 1]); // a retry asks for a different take
    expect(r.tts.calls).toHaveLength(1);
    expect(r.tts.calls[0]).toMatchObject({ text: LINE, emotion: "quiet, hurt" });
    expect(r.lipsync.calls).toHaveLength(1);
    // Lip-sync goes onto the closer of the two native clips (1 sub beats 4 dels).
    expect(r.lipsync.calls[0]!.video).toBe(finalPath(r.video.calls[0]!.out));
    expect(r.lipsync.calls[0]!.audio).toMatch(/voice-[0-9a-f]{16}\.wav$/);
    expect(r.transcribe).toHaveBeenCalledTimes(4); // 2 native clips + the TTS take + the lip-synced clip
    expect(shot).toMatchObject({ via: "lipsync", hasAudio: true, verbatim: { pass: true, wer: 0 } });

    const story = shot.attempts.map((a) => `${a.stage}:${a.n}:${a.ok}`);
    expect(story).toEqual(["video:1:false", "video:2:false", "fallback:1:true", "voice:1:true", "lipsync:1:true"]);
    expect(shot.attempts[0]!.reason).toMatch(/sub "watch" heard as "clock"/);
    expect(shot.attempts[1]!.reason).toMatch(/del/);
    expect(shot.attempts[2]!.reason).toMatch(/failed the verbatim gate 2×.*falling back to verified TTS \+ lip-sync/);
    for (const a of shot.attempts) expect(Attempt.parse(a).shotId).toBe("s1");
  }, 60_000);

  it("respects maxNative = 1 and fails loudly if even the lip-synced clip is not verbatim", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const video = new MockVideo({ faults: [{ call: 0, say: "nothing like it" }] });
    // ASR calls: 0 = native clip, 1 = TTS take (passes), 2 = lip-synced clip (mis-heard).
    const asr = new MockAsr({ faults: [{ call: 2, replace: { watch: "wash" } }] });
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 1, video, asr, tts: new MockTts(), lipsync: new MockLipsync() }).catch((e: unknown) => e);
    expect(video.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(VerbatimError);
    const attempts = (err as VerbatimError).attempts;
    expect(attempts.map((a) => a.stage)).toEqual(["video", "fallback", "voice", "lipsync"]);
    expect(attempts.at(-1)).toMatchObject({ ok: false, reason: expect.stringMatching(/"watch" heard as "wash"/) });
  }, 60_000);

  it("PolicyRejectedError is not retried with the same input and is reported clearly (acceptance 5)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, reject: "output video flagged by content policy" }] }));
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r }).catch((e: unknown) => e);

    expect(r.video.calls).toHaveLength(1);
    expect(r.tts.calls).toHaveLength(0);
    expect(r.lipsync.calls).toHaveLength(0);
    expect(err).toBeInstanceOf(ShotError);
    const e = err as ShotError;
    expect(e.cause).toBeInstanceOf(PolicyRejectedError);
    expect(e.message).toMatch(/shot s1: video provider mock-video rejected by content policy \(output video flagged by content policy\); not retried/);
    expect(e.attempts).toEqual([
      expect.objectContaining({ stage: "video", shotId: "s1", n: 1, ok: false, reason: expect.stringMatching(/content policy/) }),
    ]);
  }, 60_000);

  it("keyframe refused as a real person → the same shot as text-to-video; later takes stay text-only", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const realFace = "InputImageSensitiveContentDetected.PrivacyInformation: the input image may contain real person";
    // Call 0 is refused; call 1 (text-to-video) mishears, so a second native take (call 2) is needed.
    const r = rig(new MockVideo({ faults: [{ call: 0, reject: realFace }, { call: 1, say: "I kept the wash. I kept everything." }] }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(shot.via).toBe("native");
    expect(shot.verbatim?.pass).toBe(true);
    expect(r.video.calls).toHaveLength(3);
    expect(r.video.calls[0]!.textOnly).toBeUndefined();
    expect(r.video.calls[1]!.textOnly).toBe(true);
    expect(r.video.calls[2]!.textOnly).toBe(true);
    // Without a first frame, the prompt itself carries the look and the setting.
    expect(r.video.calls[1]!.prompt).toContain(SCRIPT.character.look);
    expect(r.video.calls[1]!.prompt).toContain(SCRIPT.setting);
    expect(r.video.calls[0]!.prompt).not.toContain(SCRIPT.setting);
    expect(shot.attempts[0]).toMatchObject({ stage: "video", n: 1, ok: false, reason: expect.stringMatching(/real person.*retrying as text-to-video/) });
  }, 60_000);

  it("a second real-person refusal while already text-only is not retried again", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, reject: "may contain real person" }, { call: 1, reject: "may contain real person" }] }));
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotError);
    expect(r.video.calls).toHaveLength(2);
    expect((err as ShotError).attempts.map((a) => a.ok)).toEqual([false, false]);
  }, 60_000);

  it("silent shot skips the gate: one video call, no ASR, no TTS", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo());
    const shot = await talkingShot(S2, kf, { script: SCRIPT, dir, ...r });
    expect(r.video.calls).toHaveLength(1);
    expect(r.video.calls[0]!.line).toBeUndefined();
    expect(r.video.calls[0]!.seconds).toBe(4);
    expect(r.transcribe).not.toHaveBeenCalled();
    expect(r.tts.calls).toHaveLength(0);
    expect(shot.via).toBe("silent");
    expect(shot).not.toHaveProperty("verbatim");
    expect(shot.attempts[0]!.reason).toMatch(/silent shot: no verbatim gate/);
  }, 60_000);

  /** Reports a length and audio flag the file doesn't have: the node must measure, not believe (hard rule 4). */
  class LyingVideo extends MockVideo {
    override async animate(req: Parameters<MockVideo["animate"]>[0]) {
      return { ...(await super.animate(req)), seconds: 99, hasAudio: !req.line };
    }
  }

  it("measures every clip with ffprobe instead of trusting the adapter's seconds / hasAudio", async () => {
    for (const [s, via] of [[S1, "native"], [S2, "silent"]] as const) {
      const dir = fresh();
      const kf = await keyframeFor(dir);
      const r = rig(new LyingVideo());
      const shot = await talkingShot(s, kf, { script: SCRIPT, dir, ...r });
      const real = await probe(shot.path);
      expect(shot.via).toBe(via);
      expect(shot.seconds).toBe(real.seconds);
      expect(shot.seconds).toBeCloseTo(s.id === "s1" ? 7 : 4, 1);
      expect(shot.hasAudio).toBe(real.hasAudio);
      expect(shot.hasAudio).toBe(via === "native"); // the liar says the opposite
    }
  }, 60_000);

  /** A lip-sync model that returns a shorter clip than it was given (Kling caps input at 10 s, others trim). */
  class TrimmingLipsync extends MockLipsync {
    override async sync(req: { video: string; audio: string; out: string }) {
      const r = await super.sync(req);
      const trimmed = `${req.out}.trim.mp4`;
      await run(muxArgs({ video: req.out, audio: req.audio, out: trimmed, seconds: 5 }));
      await rename(trimmed, req.out);
      return r;
    }
  }

  it("reports the lip-synced file's measured length, not the base clip's", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = { ...rig(new MockVideo({ faults: [{ call: 0, say: "nothing like it" }] })), lipsync: new TrimmingLipsync() };
    const measured: string[] = [];
    const spy = async (path: string) => (measured.push(path), probe(path));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 1, ...r, probe: spy });

    expect(shot.via).toBe("lipsync");
    expect(measured).toEqual([finalPath(r.video.calls[0]!.out), shot.path]); // the base clip, then the synced file
    expect((await probe(finalPath(r.video.calls[0]!.out))).seconds).toBeCloseTo(7, 1);
    expect(Math.abs(shot.seconds - 5)).toBeLessThan(0.2); // AAC framing adds a few hundredths; 7 would be the base
    expect(shot.seconds).toBe((await probe(shot.path)).seconds);
    expect(shot.hasAudio).toBe(true);
  }, 60_000);

  it("a video model without native speech goes straight to TTS + lip-sync, and says so", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ nativeSpeech: false }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, ...r });
    expect(r.video.calls).toHaveLength(1);
    expect(r.video.calls[0]!.line).toBeUndefined();
    expect(shot.via).toBe("lipsync");
    expect(shot.attempts.map((a) => a.stage)).toEqual(["video", "fallback", "voice", "lipsync"]);
    expect(shot.attempts[1]!.reason).toMatch(/no native speech/);
  }, 60_000);

  // --- Fallback failure paths keep the whole attempt story (human notes after BLOCKED) ---

  /** Native take 0 is wrong, so with maxNative 1 the shot always reaches the fallback. */
  const toFallback = () => new MockVideo({ faults: [{ call: 0, say: "nothing like it" }] });

  class BrokenLipsync extends MockLipsync {
    override async sync(req: { video: string; audio: string; out: string }): Promise<{ path: string; costUsd: number }> {
      this.calls.push(req);
      throw new Error("lipsync service 503");
    }
  }

  /** Throws on the given 0-based transcribe() call, like an ASR outage mid-run. */
  class FlakyAsr extends MockAsr {
    private seen = 0;
    constructor(private readonly failOn: number) {
      super();
    }
    override async transcribe(req: { path: string }) {
      if (this.seen++ === this.failOn) throw new Error("asr timeout");
      return super.transcribe(req);
    }
  }

  it("a lip-sync error surfaces as ShotError with every earlier attempt, including the paid voice take", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const lipsync = new BrokenLipsync();
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 1, ...rig(toFallback()), lipsync }).catch((e: unknown) => e);
    expect(lipsync.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(ShotError);
    const e = err as ShotError;
    expect(e.message).toMatch(/shot s1: lip-sync .*lipsync service 503/);
    expect((e.cause as Error).message).toBe("lipsync service 503");
    expect(e.attempts.map((a) => `${a.stage}:${a.ok}`)).toEqual(["video:false", "fallback:true", "voice:true", "lipsync:false"]);
    expect(e.attempts.at(-1)!.reason).toMatch(/lipsync service 503/);
    for (const a of e.attempts) Attempt.parse(a);
  }, 60_000);

  it("a missing lip-sync key costs nothing until the fallback is reached, then fails as a recorded NotConfiguredError", async () => {
    const lipsync = lipsyncOrDeferred({}); // no FAL_KEY, default LIPSYNC_PROVIDER=fal-kling
    const dirA = fresh();
    const ok = await talkingShot(S1, await keyframeFor(dirA), { script: SCRIPT, dir: dirA, ...rig(new MockVideo()), lipsync });
    expect(ok.via).toBe("native");

    const dirB = fresh();
    const kf = await keyframeFor(dirB);
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir: dirB, maxNative: 1, ...rig(toFallback()), lipsync }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotError);
    const e = err as ShotError;
    expect(e.cause).toBeInstanceOf(NotConfiguredError);
    expect((e.cause as Error).message).toMatch(/lipsync .*set FAL_KEY/);
    expect(e.attempts.map((a) => `${a.stage}:${a.ok}`)).toEqual(["video:false", "fallback:true", "voice:true", "lipsync:false"]);
    expect(e.attempts.at(-1)!.reason).toMatch(/FAL_KEY/);
  }, 60_000);

  it("an ASR error on the lip-synced clip surfaces as ShotError with every earlier attempt", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    // ASR calls: 0 = native clip, 1 = TTS take, 2 = lip-synced clip (throws).
    const err = await talkingShot(S1, kf, {
      script: SCRIPT,
      dir,
      maxNative: 1,
      ...rig(toFallback()),
      asr: new FlakyAsr(2),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotError);
    const e = err as ShotError;
    expect(e.message).toMatch(/asr timeout/);
    expect(e.attempts.map((a) => `${a.stage}:${a.ok}`)).toEqual(["video:false", "fallback:true", "voice:true", "lipsync:false"]);
    expect(e.attempts.at(-1)!.reason).toMatch(/asr timeout/);
  }, 60_000);

  it("an ASR error on a native clip surfaces as ShotError with the attempts so far", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, say: "nothing like it" }] }));
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r, asr: new FlakyAsr(1) }).catch((e: unknown) => e);
    expect(r.video.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(ShotError);
    expect((err as ShotError).attempts.map((a) => `${a.stage}:${a.n}:${a.ok}`)).toEqual(["video:1:false", "video:2:false"]);
    expect((err as ShotError).attempts.at(-1)!.reason).toMatch(/asr timeout/);
  }, 60_000);

  /** Like live GroqAsr: extracting `-map 0:a:0` from a file with no audio stream throws. */
  class StrictAsr extends MockAsr {
    readonly seen: string[] = [];
    override async transcribe(req: { path: string }) {
      this.seen.push(req.path);
      if (!(await probe(req.path)).hasAudio) throw new Error(`no audio stream in ${req.path}`);
      return super.transcribe(req);
    }
  }

  it("a native clip without an audio track is a failed take: retried, never sent to ASR", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const asr = new StrictAsr();
    const r = { ...rig(new MockVideo({ faults: [{ call: 0, say: "" }] })), asr }; // take 1 comes back silent
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(r.video.calls).toHaveLength(2);
    expect(asr.seen).toEqual([finalPath(r.video.calls[1]!.out)]); // the silent take never reached ASR
    expect(shot).toMatchObject({ via: "native", hasAudio: true, verbatim: { pass: true } });
    expect(shot.attempts.map((a) => `${a.stage}:${a.n}:${a.ok}`)).toEqual(["video:1:false", "video:2:true"]);
    expect(shot.attempts[0]).toMatchObject({ provider: "mock-video", reason: expect.stringMatching(/no audio track/) });
    for (const a of shot.attempts) Attempt.parse(a);
  }, 60_000);

  it("every native take silent → TTS + lip-sync fallback, not a ShotError", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const asr = new StrictAsr();
    const r = { ...rig(new MockVideo({ faults: [{ call: 0, say: "" }, { call: 1, say: "" }] })), asr };
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(r.video.calls).toHaveLength(2);
    expect(r.tts.calls).toHaveLength(1);
    expect(r.lipsync.calls).toHaveLength(1);
    expect(r.lipsync.calls[0]!.video).toBe(finalPath(r.video.calls[0]!.out));
    expect(asr.seen.some((p) => r.video.calls.some((c) => finalPath(c.out) === p))).toBe(false);
    expect(shot).toMatchObject({ via: "lipsync", hasAudio: true, verbatim: { pass: true } });
    expect(shot.attempts.map((a) => `${a.stage}:${a.n}:${a.ok}`)).toEqual([
      "video:1:false",
      "video:2:false",
      "fallback:1:true",
      "voice:1:true",
      "lipsync:1:true",
    ]);
    expect(shot.attempts[2]!.reason).toMatch(/native speech failed 2×.*no take had an audio track.*falling back/);
    for (const a of shot.attempts) Attempt.parse(a);
  }, 60_000);

  it("a clip longer than the lip-sync model's maxSeconds is trimmed to speechEnd + 0.4 s before syncing", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const lipsync = new MockLipsync({ maxSeconds: 5 }); // the 7 s native clip is too long for it
    const r = { ...rig(toFallback()), lipsync };
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 1, ...r });

    const voiceAttempt = shot.attempts.find((a) => a.stage === "voice")!;
    expect(voiceAttempt.ok).toBe(true);
    expect(lipsync.calls).toHaveLength(1);
    const sent = lipsync.calls[0]!.video;
    expect(sent).not.toBe(finalPath(r.video.calls[0]!.out)); // not the raw 7 s clip
    const voice = await probe(lipsync.calls[0]!.audio);
    const sentLen = (await probe(sent)).seconds;
    expect(sentLen).toBeLessThanOrEqual(5);
    expect(sentLen).toBeGreaterThan(voice.seconds - 0.3); // the whole spoken line is still in the clip
    expect(shot).toMatchObject({ via: "lipsync", verbatim: { pass: true } });
    expect(shot.speechEnd!).toBeLessThan(sentLen);
    expect(shot.attempts.map((a) => `${a.stage}:${a.ok}`)).toEqual(["video:false", "fallback:true", "voice:true", "trim:true", "lipsync:true"]);
    const trim = shot.attempts.find((a) => a.stage === "trim")!;
    expect(trim.reason).toMatch(/7(\.\d+)? s clip > mock-lipsync max 5 s; trimmed to \d+(\.\d+)? s \(speech ends at \d+(\.\d+)? s \+ 0\.4 s\)/);
    for (const a of shot.attempts) Attempt.parse(a);
  }, 60_000);

  it("fails with a readable, recorded reason when even the trimmed clip is too long (no silent cut of speech)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const lipsync = new MockLipsync({ maxSeconds: 2 }); // the line alone takes ~2.8 s
    const err = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 1, ...rig(toFallback()), lipsync }).catch((e: unknown) => e);
    expect(lipsync.calls).toHaveLength(0);
    expect(err).toBeInstanceOf(ShotError);
    const e = err as ShotError;
    expect(e.message).toMatch(/mock-lipsync accepts at most 2 s.*speech ends at \d+(\.\d+)? s/);
    expect(e.attempts.map((a) => `${a.stage}:${a.ok}`)).toEqual(["video:false", "fallback:true", "voice:true", "trim:false"]);
  }, 60_000);

  it("is idempotent: a resumed native shot makes no new video call", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    await talkingShot(S1, kf, { script: SCRIPT, dir, ...rig(new MockVideo()) });
    const r = rig(new MockVideo());
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, ...r });
    expect(r.video.calls).toHaveLength(0);
    expect(shot.via).toBe("native");
    expect(shot.attempts[0]!.reason).toMatch(/reused cached clip/);
  }, 60_000);
});

/** Providers write to once()'s tmp name (`<name>.tmp-<pid>-<hex>.<ext>`); this is the file it becomes. */
const finalPath = (tmp: string): string => tmp.replace(/\.tmp-\d+-[0-9a-f]+(\.\w+)$/, "$1");

// --- Live adapters: request shapes with injected fakes (acceptance 7). No network: global fetch throws. ---

describe("live adapters (acceptance 7, no network)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network access in a unit test");
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const VIDEO_BYTES = Buffer.from("not really an mp4");
  /**
   * Fake ffprobe (the bytes above are not a real mp4). Its answer deliberately differs from the request
   * (7.04 s, no audio) so a test can tell a measured value from an echoed one.
   */
  function fakeProbe(media = { seconds: 7.04, hasAudio: false }) {
    const probed: string[] = [];
    const probe = async (path: string) => {
      probed.push(path);
      return media;
    };
    return { probe, probed };
  }
  /** Fake fetch: answers by "METHOD url" from a table, records every call. */
  function fakeFetch(routes: Record<string, (init: RequestInit) => Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const route = routes[`${init.method ?? "GET"} ${url}`];
      if (!route) throw new Error(`unexpected request ${init.method} ${url}`);
      return route(init);
    };
    return { fetch, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /**
   * The fake fal storage names an upload by a hash of its bytes, not by arrival order: uploads may run in
   * parallel, so an order-based URL would make the image_urls checks flaky and blind to a reorder bug.
   */
  const upUrlOf = (bytes: Uint8Array) => `https://fal.media/up/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const upUrl = async (path: string) => upUrlOf(await readFile(path));

  function fakeFal(result: unknown) {
    const subscribed: { endpoint: string; input: Record<string, unknown> }[] = [];
    const uploads: Blob[] = [];
    const fal: FalLike = {
      async subscribe(endpoint, { input }) {
        subscribed.push({ endpoint, input });
        if (result instanceof Error) throw result;
        return { data: result, requestId: "req-1" };
      },
      storage: {
        async upload(file) {
          uploads.push(file);
          return upUrlOf(new Uint8Array(await file.arrayBuffer()));
        },
      },
    };
    return { fal, subscribed, uploads };
  }

  let kf: string;
  /** A second, byte-different PNG so multi-upload tests can tell the files (and their order) apart. */
  let kf2: string;
  beforeAll(async () => {
    kf = await keyframeFor(fresh());
    kf2 = join(root, "kf2.png");
    await writeFile(kf2, Buffer.concat([await readFile(kf), Buffer.from("second ref")]));
  });

  describe("Seedance via fal", () => {
    it("sends the documented image-to-video input and downloads video.url", async () => {
      const f = fakeFal({ video: { url: "https://v3.fal.media/out.mp4" }, seed: 42 });
      const { fetch, calls } = fakeFetch({ "GET https://v3.fal.media/out.mp4": () => new Response(VIDEO_BYTES) });
      const p = fakeProbe();
      const video = new SeedanceVideo({ transport: new FalSeedance({ fal: f.fal }), fetch, probe: p.probe });
      const out = join(root, "fal-clip.mp4");
      const r = await video.animate({ image: kf, prompt: "P", seconds: 7, out, line: LINE });

      expect(video.capabilities).toEqual({ nativeSpeech: true, durations: SEEDANCE_DURATIONS });
      expect(SEEDANCE_DURATIONS).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(f.uploads).toHaveLength(1);
      expect(f.uploads[0]!.type).toBe("image/png");
      expect(f.subscribed).toEqual([
        {
          endpoint: "bytedance/seedance-2.0/image-to-video",
          input: {
            prompt: "P",
            image_url: await upUrl(kf),
            duration: "7", // the fal schema's enum is strings
            aspect_ratio: "9:16",
            resolution: "720p",
            generate_audio: true,
          },
        },
      ]);
      expect(calls.map((c) => c.url)).toEqual(["https://v3.fal.media/out.mp4"]);
      expect(await readFile(out)).toEqual(VIDEO_BYTES);
      // Length and audio are measured on the downloaded file, not echoed from the request; cost is per requested s.
      expect(p.probed).toEqual([out]);
      expect(r).toEqual({ path: out, seconds: 7.04, hasAudio: false, costUsd: 7 * 0.3034 });
    });

    it("fast tier uses the fast endpoint and price", async () => {
      const f = fakeFal({ video: { url: "https://v3.fal.media/f.mp4" } });
      const { fetch } = fakeFetch({ "GET https://v3.fal.media/f.mp4": () => new Response(VIDEO_BYTES) });
      const video = new SeedanceVideo({ transport: new FalSeedance({ fal: f.fal, tier: "fast" }), fetch, probe: fakeProbe().probe });
      const r = await video.animate({ image: kf, prompt: "P", seconds: 4, out: join(root, "fast.mp4") });
      expect(f.subscribed[0]!.endpoint).toBe("bytedance/seedance-2.0/fast/image-to-video");
      expect(r.costUsd).toBeCloseTo(4 * 0.2419, 6);
      expect(video.name).toBe("fal-seedance-2.0-fast");
    });

    it("maps a 422 content_policy_violation to PolicyRejectedError; other errors pass through", async () => {
      const policy = new ValidationError({
        message: "Unprocessable Entity",
        status: 422,
        body: { detail: [{ loc: ["body", "image_url"], msg: "Input image flagged", type: "content_policy_violation" }] },
      });
      const v1 = new SeedanceVideo({ transport: new FalSeedance({ fal: fakeFal(policy).fal }), fetch: fakeFetch({}).fetch });
      const err = await v1.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "p.mp4") }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PolicyRejectedError);
      expect((err as PolicyRejectedError).detail).toBe("Input image flagged");

      const boom = new ApiError({ message: "Internal", status: 500, body: { detail: "downstream_service_error" } });
      const v2 = new SeedanceVideo({ transport: new FalSeedance({ fal: fakeFal(boom).fal }), fetch: fakeFetch({}).fetch });
      await expect(v2.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "q.mp4") })).rejects.toBe(boom);
    });

    it("rejects a duration Seedance does not accept before any call", async () => {
      const f = fakeFal({ video: { url: "x" } });
      const video = new SeedanceVideo({ transport: new FalSeedance({ fal: f.fal }), fetch: fakeFetch({}).fetch });
      await expect(video.animate({ image: kf, prompt: "P", seconds: 6.5, out: join(root, "r.mp4") })).rejects.toThrow(RangeError);
      expect(f.subscribed).toHaveLength(0);
    });
  });

  describe("Seedance via BytePlus ModelArk", () => {
    const TASKS = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

    it("creates a task, polls until succeeded, downloads content.video_url", async () => {
      let polls = 0;
      const { fetch, calls } = fakeFetch({
        [`POST ${TASKS}`]: () => json({ id: "cgt-123" }),
        [`GET ${TASKS}/cgt-123`]: () =>
          ++polls < 3
            ? json({ id: "cgt-123", status: polls === 1 ? "queued" : "running" })
            : json({ id: "cgt-123", status: "succeeded", content: { video_url: "https://ark-cdn.example/v.mp4" } }),
        "GET https://ark-cdn.example/v.mp4": () => new Response(VIDEO_BYTES),
      });
      const sleeps: number[] = [];
      const transport = new BytePlusSeedance({ apiKey: "ark-key", fetch, sleep: async (ms) => void sleeps.push(ms), pollMs: 10 });
      const p = fakeProbe({ seconds: 6.96, hasAudio: true });
      const video = new SeedanceVideo({ transport, fetch, probe: p.probe });
      const out = join(root, "bp.mp4");
      const r = await video.animate({ image: kf, prompt: `Dan says: "${LINE}"`, seconds: 7, out, line: LINE });

      expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
        `POST ${TASKS}`,
        `GET ${TASKS}/cgt-123`,
        `GET ${TASKS}/cgt-123`,
        `GET ${TASKS}/cgt-123`,
        "GET https://ark-cdn.example/v.mp4",
      ]);
      expect(sleeps).toEqual([10, 10]);
      const create = calls[0]!;
      expect(create.init.headers).toEqual({ Authorization: "Bearer ark-key", "Content-Type": "application/json" });
      const body = JSON.parse(String(create.init.body)) as Record<string, unknown> & { content: Record<string, unknown>[] };
      expect(body).toMatchObject({
        model: "dreamina-seedance-2-0-260128",
        ratio: "9:16",
        duration: 7, // an integer here, unlike fal
        resolution: "720p",
        generate_audio: true,
        watermark: false,
      });
      expect(body.content[0]).toEqual({ type: "text", text: `Dan says: "${LINE}"` });
      expect(body.content[1]).toMatchObject({ type: "image_url", role: "first_frame" });
      expect((body.content[1]!.image_url as { url: string }).url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
      expect(calls[1]!.init.headers).toMatchObject({ Authorization: "Bearer ark-key" });
      expect(await readFile(out)).toEqual(VIDEO_BYTES);
      // No usage in the reply → list price: $7 / 1M tokens × (720·1280·24/1024 = 21 600 tokens/s).
      expect(r.costUsd).toBeCloseTo(7 * 0.1512, 6);
      expect(p.probed).toEqual([out]);
      expect(r).toMatchObject({ path: out, seconds: 6.96, hasAudio: true });
    });

    it("bills usage.completion_tokens when the task reports it; fast tier uses the fast model and price", async () => {
      const done = (usage?: unknown) =>
        fakeFetch({
          [`POST ${TASKS}`]: () => json({ id: "t9" }),
          [`GET ${TASKS}/t9`]: () =>
            json({ id: "t9", status: "succeeded", content: { video_url: "https://ark-cdn.example/u.mp4" }, ...(usage ? { usage } : {}) }),
          "GET https://ark-cdn.example/u.mp4": () => new Response(VIDEO_BYTES),
        });
      const f1 = done({ completion_tokens: 108000 });
      const v1 = new SeedanceVideo({ transport: new BytePlusSeedance({ apiKey: "k", fetch: f1.fetch }), fetch: f1.fetch, probe: fakeProbe().probe });
      const r1 = await v1.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "u1.mp4") });
      expect(r1.costUsd).toBeCloseTo((108000 * 7) / 1e6, 9);

      const f2 = done({ completion_tokens: 108000 });
      const fast = new BytePlusSeedance({ apiKey: "k", tier: "fast", fetch: f2.fetch });
      expect(fast.name).toBe("byteplus-seedance-2.0-fast");
      expect(fast.usdPerSecond).toBeCloseTo(0.12096, 9);
      const v2 = new SeedanceVideo({ transport: fast, fetch: f2.fetch, probe: fakeProbe().probe });
      const r2 = await v2.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "u2.mp4") });
      expect(JSON.parse(String(f2.calls[0]!.init.body))).toMatchObject({ model: "dreamina-seedance-2-0-fast-260128" });
      expect(r2.costUsd).toBeCloseTo((108000 * 5.6) / 1e6, 9);
    });

    it("real-face rejection (HTTP 400 or a failed task) → PolicyRejectedError; other failures stay plain errors", async () => {
      const realFace = fakeFetch({
        [`POST ${TASKS}`]: () =>
          json({ error: { code: "InvalidParameter", message: "The request failed because the input image may contain a real person." } }, 400),
      });
      const v1 = new SeedanceVideo({ transport: new BytePlusSeedance({ apiKey: "k", fetch: realFace.fetch }), fetch: realFace.fetch });
      await expect(v1.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "rf.mp4") })).rejects.toBeInstanceOf(PolicyRejectedError);

      const failed = (error: unknown) =>
        fakeFetch({
          [`POST ${TASKS}`]: () => json({ id: "t1" }),
          [`GET ${TASKS}/t1`]: () => json({ id: "t1", status: "failed", error }),
        });
      const f2 = failed({ code: "OutputVideoSensitiveContentDetected", message: "output flagged" });
      const v2 = new SeedanceVideo({ transport: new BytePlusSeedance({ apiKey: "k", fetch: f2.fetch, sleep: async () => {} }), fetch: f2.fetch });
      await expect(v2.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "rf2.mp4") })).rejects.toBeInstanceOf(PolicyRejectedError);

      const f3 = failed({ code: "InternalServiceError", message: "try later" });
      const v3 = new SeedanceVideo({ transport: new BytePlusSeedance({ apiKey: "k", fetch: f3.fetch, sleep: async () => {} }), fetch: f3.fetch });
      const e3 = await v3.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "rf3.mp4") }).catch((e: unknown) => e);
      expect(e3).not.toBeInstanceOf(PolicyRejectedError);
      expect((e3 as Error).message).toMatch(/task t1 failed: InternalServiceError: try later/);

      const f4 = fakeFetch({ [`POST ${TASKS}`]: () => json({ error: { code: "AuthenticationError" } }, 401) });
      const v4 = new SeedanceVideo({ transport: new BytePlusSeedance({ apiKey: "k", fetch: f4.fetch }), fetch: f4.fetch });
      await expect(v4.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "rf4.mp4") })).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe("Seedance via OpenRouter", () => {
    const API = "https://openrouter.ai/api/v1/videos";

    it("textOnly sends no first frame (OpenRouter and BytePlus) and needs no keyframe file", async () => {
      const job = { image: "/does/not/exist.png", prompt: "P", seconds: 5, textOnly: true };
      const orBody = await new OpenRouterSeedance({ apiKey: "k" }).body(job);
      expect(orBody).not.toHaveProperty("frame_images");
      expect(orBody).toMatchObject({ prompt: "P", duration: 5, aspect_ratio: "9:16", generate_audio: true });
      const bpBody = new BytePlusSeedance({ apiKey: "k" }).body(job, undefined);
      expect(bpBody.content).toEqual([{ type: "text", text: "P" }]);
    });

    it("submits the documented body, polls the job, downloads /content with the key, bills usage.cost", async () => {
      let polls = 0;
      const { fetch, calls } = fakeFetch({
        [`POST ${API}`]: () => json({ id: "gen-vid-1", polling_url: "/api/v1/videos/gen-vid-1", status: "pending" }, 202),
        [`GET ${API}/gen-vid-1`]: () =>
          ++polls < 3
            ? json({ id: "gen-vid-1", status: polls === 1 ? "pending" : "in_progress" })
            : json({
                id: "gen-vid-1",
                status: "completed",
                unsigned_urls: [`${API}/gen-vid-1/content?index=0`],
                usage: { cost: 1.0584, is_byok: false },
              }),
        [`GET ${API}/gen-vid-1/content`]: () => new Response(VIDEO_BYTES),
      });
      const sleeps: number[] = [];
      const transport = new OpenRouterSeedance({ apiKey: "or-key", fetch, sleep: async (ms) => void sleeps.push(ms), pollMs: 10 });
      const p = fakeProbe({ seconds: 6.96, hasAudio: true });
      const video = new SeedanceVideo({ transport, fetch, probe: p.probe });
      expect(video.name).toBe("openrouter-seedance-2.0");
      const out = join(root, "or.mp4");
      const r = await video.animate({ image: kf, prompt: `Dan says: "${LINE}"`, seconds: 7, out, line: LINE, variant: 2, refs: [kf2] });

      expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
        `POST ${API}`,
        `GET ${API}/gen-vid-1`,
        `GET ${API}/gen-vid-1`,
        `GET ${API}/gen-vid-1`,
        `GET ${API}/gen-vid-1/content`,
      ]);
      expect(sleeps).toEqual([10, 10, 10]);
      expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer or-key", "Content-Type": "application/json" });
      const keyframeUrl = `data:image/png;base64,${(await readFile(kf)).toString("base64")}`;
      const refUrl = `data:image/png;base64,${(await readFile(kf2)).toString("base64")}`;
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        model: "bytedance/seedance-2.0",
        prompt: `Dan says: "${LINE}"`,
        duration: 7, // integer, like BytePlus
        resolution: "720p",
        aspect_ratio: "9:16",
        generate_audio: true,
        frame_images: [{ type: "image_url", image_url: { url: keyframeUrl }, frame_type: "first_frame" }],
        input_references: [{ type: "image_url", image_url: { url: refUrl } }],
        seed: 2,
        provider: { options: { seed: { watermark: false } } },
      });
      expect(calls[1]!.init.headers).toEqual({ Authorization: "Bearer or-key" });
      // The content endpoint is not pre-signed: the download must carry the key.
      expect(calls[4]!.init.headers).toEqual({ Authorization: "Bearer or-key" });
      expect(await readFile(out)).toEqual(VIDEO_BYTES);
      expect(r.costUsd).toBe(1.0584);
      // Measured, not echoed (same as the other transports).
      expect(p.probed).toEqual([out]);
      expect(r).toMatchObject({ path: out, seconds: 6.96, hasAudio: true });
    });

    it("without usage.cost bills the token estimate; fast tier uses the fast model and $4.2/M; no refs/seed → omitted", async () => {
      const done = () =>
        fakeFetch({
          [`POST ${API}`]: () => json({ id: "j2", polling_url: "/api/v1/videos/j2", status: "pending" }, 202),
          [`GET ${API}/j2`]: () => json({ id: "j2", status: "completed", usage: { cost: null } }),
          [`GET ${API}/j2/content`]: () => new Response(VIDEO_BYTES),
        });
      const tokensPerSecond = (720 * 1280 * 24) / 1024; // 21 600
      const f1 = done();
      const std = new OpenRouterSeedance({ apiKey: "k", fetch: f1.fetch, sleep: async () => {} });
      expect(std.usdPerSecond).toBeCloseTo(0.1512, 9);
      const r1 = await new SeedanceVideo({ transport: std, fetch: f1.fetch, probe: fakeProbe().probe }).animate({
        image: kf,
        prompt: "P",
        seconds: 5,
        out: join(root, "or1.mp4"),
      });
      expect(r1.costUsd).toBeCloseTo(tokensPerSecond * 5 * 7e-6, 9);
      const b1 = JSON.parse(String(f1.calls[0]!.init.body)) as Record<string, unknown>;
      expect(b1).not.toHaveProperty("input_references");
      expect(b1).not.toHaveProperty("seed");

      const f2 = done();
      const fast = new OpenRouterSeedance({ apiKey: "k", tier: "fast", fetch: f2.fetch, sleep: async () => {} });
      expect(fast.name).toBe("openrouter-seedance-2.0-fast");
      expect(fast.usdPerSecond).toBeCloseTo(0.09072, 9);
      const v2 = new SeedanceVideo({ transport: fast, fetch: f2.fetch, probe: fakeProbe().probe });
      expect(v2.estimateUsd({ image: kf, prompt: "P", seconds: 10, out: "" })).toBeCloseTo(0.9072, 9);
      const r2 = await v2.animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "or2.mp4") });
      expect(JSON.parse(String(f2.calls[0]!.init.body))).toMatchObject({ model: "bytedance/seedance-2.0-fast" });
      expect(r2.costUsd).toBeCloseTo(tokensPerSecond * 5 * 4.2e-6, 9);
    });

    it("failed / expired jobs and policy texts: PolicyRejectedError only for moderation, no download", async () => {
      const ended = (status: string, error?: string) =>
        fakeFetch({
          [`POST ${API}`]: () => json({ id: "j3", polling_url: "/api/v1/videos/j3", status: "pending" }, 202),
          [`GET ${API}/j3`]: () => json({ id: "j3", status, ...(error ? { error } : {}) }),
        });
      const run = async (f: ReturnType<typeof fakeFetch>) =>
        new SeedanceVideo({ transport: new OpenRouterSeedance({ apiKey: "k", fetch: f.fetch, sleep: async () => {} }), fetch: f.fetch })
          .animate({ image: kf, prompt: "P", seconds: 5, out: join(root, "or3.mp4") })
          .catch((e: unknown) => e);

      const policy = ended("failed", "Content policy violation");
      expect(await run(policy)).toBeInstanceOf(PolicyRejectedError);
      expect(policy.calls).toHaveLength(2); // submit + one poll, never a download

      const e2 = await run(ended("failed", "upstream timeout"));
      expect(e2).not.toBeInstanceOf(PolicyRejectedError);
      expect((e2 as Error).message).toMatch(/job j3 failed: upstream timeout/);
      expect(((await run(ended("expired"))) as Error).message).toMatch(/job j3 expired: expired/);

      const rejected = fakeFetch({
        [`POST ${API}`]: () => json({ error: { code: 400, message: "the input image may contain a real person" } }, 400),
      });
      expect(await run(rejected)).toBeInstanceOf(PolicyRejectedError);
      const broke = fakeFetch({ [`POST ${API}`]: () => json({ error: { code: 402, message: "Insufficient credits" } }, 402) });
      const e5 = await run(broke);
      expect(e5).toBeInstanceOf(HttpError);
      expect((e5 as HttpError).status).toBe(402);
    });
  });

  it("seedanceFromEnv picks the transport from SEEDANCE_TRANSPORT and names the missing key", () => {
    const f = fakeFal({}).fal;
    expect(seedanceFromEnv({ FAL_KEY: "x" }, { fal: f }).name).toBe("fal-seedance-2.0");
    expect(seedanceFromEnv({ SEEDANCE_TRANSPORT: "fal", SEEDANCE_TIER: "fast" }, { fal: f }).name).toBe("fal-seedance-2.0-fast");
    expect(seedanceFromEnv({ SEEDANCE_TRANSPORT: "byteplus", ARK_API_KEY: "k" }).name).toBe("byteplus-seedance-2.0");
    expect(seedanceFromEnv({ SEEDANCE_TRANSPORT: "byteplus", SEEDANCE_TIER: "fast", ARK_API_KEY: "k" }).name).toBe("byteplus-seedance-2.0-fast");
    expect(() => seedanceFromEnv({ SEEDANCE_TRANSPORT: "byteplus", FAL_KEY: "x" })).toThrow(NotConfiguredError);
    expect(() => seedanceFromEnv({ SEEDANCE_TRANSPORT: "byteplus" })).toThrow(/ARK_API_KEY/);
    expect(() => seedanceFromEnv({})).toThrow(/FAL_KEY/);
    expect(() => seedanceFromEnv({ SEEDANCE_TRANSPORT: "replicate" })).toThrow(/unknown "replicate"/);
    expect(seedanceFromEnv({ SEEDANCE_TRANSPORT: "openrouter", OPENROUTER_API_KEY: "k" }).name).toBe("openrouter-seedance-2.0");
    expect(seedanceFromEnv({ SEEDANCE_TRANSPORT: "OpenRouter", SEEDANCE_TIER: "fast", OPENROUTER_API_KEY: "k" }).name).toBe(
      "openrouter-seedance-2.0-fast",
    );
    expect(() => seedanceFromEnv({ SEEDANCE_TRANSPORT: "openrouter", FAL_KEY: "x", ARK_API_KEY: "a" })).toThrow(/OPENROUTER_API_KEY/);
  });

  describe("image providers", () => {
    it("fal nano-banana: edit endpoint with uploaded refs, text endpoint without", async () => {
      const f = fakeFal({ images: [{ url: "https://fal.media/img.png" }] });
      const { fetch } = fakeFetch({ "GET https://fal.media/img.png": () => new Response(Buffer.from("png")) });
      const image = new FalNanoBananaImage({ fal: f.fal, fetch });
      const r = await image.generate({ prompt: "K", refs: [kf2, kf], out: join(root, "nb.png") });
      await image.generate({ prompt: "P", out: join(root, "nb2.png") });
      expect(f.subscribed).toEqual([
        {
          endpoint: "fal-ai/nano-banana/edit",
          input: {
            prompt: "K",
            aspect_ratio: "9:16",
            num_images: 1,
            output_format: "png",
            image_urls: [await upUrl(kf2), await upUrl(kf)], // request order, whatever order the uploads finish in
          },
        },
        { endpoint: "fal-ai/nano-banana", input: { prompt: "P", aspect_ratio: "9:16", num_images: 1, output_format: "png" } },
      ]);
      expect(r.costUsd).toBe(0.039);
      expect(await readFile(r.path, "utf8")).toBe("png");
    });

    it("gemini: Interactions request with inline refs and 9:16; writes the returned image", async () => {
      const { fetch, calls } = fakeFetch({
        "POST https://generativelanguage.googleapis.com/v1beta/interactions": () =>
          json({ steps: [{ type: "model_output", content: [{ type: "text" }, { type: "image", data: Buffer.from("IMG").toString("base64") }] }] }),
      });
      const image = new GeminiImage({ apiKey: "g-key", fetch });
      const r = await image.generate({ prompt: "K", refs: [kf], out: join(root, "gm.png") });
      expect(calls[0]!.init.headers).toMatchObject({ "x-goog-api-key": "g-key" });
      const body = JSON.parse(String(calls[0]!.init.body)) as {
        model: string;
        input: { type: string; content: Record<string, unknown>[] }[];
        response_format: unknown;
      };
      expect(body.model).toBe("gemini-nano-banana-2.1");
      expect(body.response_format).toEqual({ type: "image", aspect_ratio: "9:16", image_size: "1K" });
      expect(body.input[0]!.content[0]).toEqual({ type: "text", text: "K" });
      expect(body.input[0]!.content[1]).toMatchObject({ type: "image", mime_type: "image/png" });
      expect(await readFile(r.path, "utf8")).toBe("IMG");
    });

    it("seedream: BytePlus images/generations with data-URL refs", async () => {
      const { fetch, calls } = fakeFetch({
        "POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations": () =>
          json({ data: [{ b64_json: Buffer.from("SD").toString("base64") }] }),
      });
      const image = new SeedreamImage({ apiKey: "ark", fetch });
      const r = await image.generate({ prompt: "K", refs: [kf], out: join(root, "sd.png") });
      const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "seedream-5-0-lite-260128", prompt: "K", size: "1440x2560", response_format: "b64_json", watermark: false });
      expect((body.image as string[])[0]).toMatch(/^data:image\/png;base64,/);
      expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer ark" });
      expect(await readFile(r.path, "utf8")).toBe("SD");
    });

    it("openrouter: Image API with 9:16, data-URL refs, per-model knobs; bills usage.cost", async () => {
      const { fetch, calls } = fakeFetch({
        "POST https://openrouter.ai/api/v1/images": () =>
          json({ created: 1, data: [{ b64_json: Buffer.from("ORI").toString("base64"), media_type: "image/png" }], usage: { cost: 0.0341 } }),
      });
      const image = new OpenRouterImage({ apiKey: "or", fetch });
      expect(image.estimateUsd()).toBe(0.0336);
      const r = await image.generate({ prompt: "K", refs: [kf2, kf], out: join(root, "or.png"), variant: 3 });
      expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer or", "Content-Type": "application/json" });
      const dataOf = async (p: string) => `data:image/png;base64,${(await readFile(p)).toString("base64")}`;
      // gemini-nano-banana-2.1 lists no `seed`, and unlisted parameters are rejected: none is sent.
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        model: "google/gemini-nano-banana-2.1",
        prompt: "K",
        aspect_ratio: "9:16",
        n: 1,
        resolution: "1K",
        input_references: [
          { type: "image_url", image_url: { url: await dataOf(kf2) } },
          { type: "image_url", image_url: { url: await dataOf(kf) } },
        ],
      });
      expect(r.costUsd).toBe(0.0341);
      expect(await readFile(r.path, "utf8")).toBe("ORI");

      const f2 = fakeFetch({
        "POST https://openrouter.ai/api/v1/images": () => json({ data: [{ b64_json: Buffer.from("S").toString("base64") }] }),
      });
      const flash = new OpenRouterImage({ apiKey: "or", model: "bytedance-seed/seedream-5-0-flash", fetch: f2.fetch });
      const r2 = await flash.generate({ prompt: "P", out: join(root, "or2.png"), variant: 3 });
      expect(JSON.parse(String(f2.calls[0]!.init.body))).toEqual({
        model: "bytedance-seed/seedream-5-0-flash",
        prompt: "P",
        aspect_ratio: "9:16",
        n: 1,
        resolution: "1K",
        seed: 3,
      });
      expect(r2.costUsd).toBe(0.018); // no usage in the reply → list price
      expect(new OpenRouterImage({ apiKey: "or", model: "someone/new-model" }).estimateUsd()).toBe(0.04);
    });

    it("imageFromEnv selects by IMAGE_PROVIDER", () => {
      expect(imageFromEnv({ FAL_KEY: "x" }, { fal: fakeFal({}).fal }).name).toBe("fal-nano-banana");
      expect(imageFromEnv({ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "g" }).name).toBe("gemini-image");
      expect(imageFromEnv({ IMAGE_PROVIDER: "seedream", ARK_API_KEY: "a" }).name).toBe("byteplus-seedream");
      expect(() => imageFromEnv({ IMAGE_PROVIDER: "seedream" })).toThrow(NotConfiguredError);
      expect(() => imageFromEnv({ IMAGE_PROVIDER: "dalle" })).toThrow(/unknown "dalle"/);
      expect(imageFromEnv({ IMAGE_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o" }).name).toBe("openrouter-image");
      expect((imageFromEnv({ IMAGE_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o", OPENROUTER_IMAGE_MODEL: "x/y" }) as OpenRouterImage).model).toBe("x/y");
      expect(() => imageFromEnv({ IMAGE_PROVIDER: "openrouter", FAL_KEY: "f" })).toThrow(/OPENROUTER_API_KEY/);
    });
  });

  describe("lip-sync providers", () => {
    it("fal kling: uploads video + audio, documented input, cost rounded up to 5 s", async () => {
      const f = fakeFal({ video: { url: "https://fal.media/ls.mp4" } });
      const { fetch } = fakeFetch({ "GET https://fal.media/ls.mp4": () => new Response(VIDEO_BYTES) });
      const ls = new FalKlingLipsync({ fal: f.fal, fetch, probe: async () => ({ seconds: 7 }) });
      const video = join(root, "ls-in.mp4");
      const audio = join(root, "ls-in.wav");
      await writeFile(video, VIDEO_BYTES);
      await writeFile(audio, Buffer.from("RIFF fake wav"));
      const r = await ls.sync({ video, audio, out: join(root, "ls.mp4") });
      expect(f.subscribed).toEqual([
        {
          endpoint: "fal-ai/kling-video/lipsync/audio-to-video",
          input: { video_url: await upUrl(video), audio_url: await upUrl(audio) },
        },
      ]);
      expect(ls.maxSeconds).toBe(10); // documented Kling lip-sync input limit: video 2–10 s
      expect(r.costUsd).toBeCloseTo(10 * 0.014, 6);
      expect(klingLipsyncCost(5)).toBeCloseTo(0.07, 6);
      expect(await readFile(r.path)).toEqual(VIDEO_BYTES);
    });

    it("command: substitutes placeholders into argv (no shell) and checks the output exists", async () => {
      const argv = commandArgv(`python "/opt/latent sync/run.py" --video={video} --audio {audio} -o {out}`, {
        video: "/v.mp4",
        audio: "/a b.wav",
        out: "/o.mp4",
      });
      expect(argv).toEqual(["python", "/opt/latent sync/run.py", "--video=/v.mp4", "--audio", "/a b.wav", "-o", "/o.mp4"]);
      expect(() => new CommandLipsync({ template: "latentsync {video} {out}" })).toThrow(/\{audio\}/);

      const ran: string[][] = [];
      const out = join(root, "cmd.mp4");
      const ok = new CommandLipsync({
        template: "ls-run {video} {audio} {out}",
        run: async (cmd, args) => {
          ran.push([cmd, ...args]);
          await writeFile(args[2]!, "x");
        },
      });
      expect(await ok.sync({ video: "/v.mp4", audio: "/a.wav", out })).toEqual({ path: out, costUsd: 0 });
      expect(ran).toEqual([["ls-run", "/v.mp4", "/a.wav", out]]);

      const lazy = new CommandLipsync({ template: "noop {video} {audio} {out}", run: async () => {} });
      await expect(lazy.sync({ video: "/v", audio: "/a", out: join(root, "never.mp4") })).rejects.toThrow(/did not write/);
    });

    it("lipsyncFromEnv selects by LIPSYNC_PROVIDER", () => {
      expect(lipsyncFromEnv({ FAL_KEY: "x" }, { fal: fakeFal({}).fal }).name).toBe("fal-kling-lipsync");
      const cmd = lipsyncFromEnv({ LIPSYNC_PROVIDER: "command", LIPSYNC_CMD: "x {video} {audio} {out}" });
      expect(cmd.name).toBe("command-lipsync");
      expect(cmd.maxSeconds).toBe(Infinity);
      const capped = { LIPSYNC_PROVIDER: "command", LIPSYNC_CMD: "x {video} {audio} {out}", LIPSYNC_MAX_SECONDS: "8" };
      expect(lipsyncFromEnv(capped).maxSeconds).toBe(8);
      expect(() => lipsyncFromEnv({ ...capped, LIPSYNC_MAX_SECONDS: "abc" })).toThrow(/LIPSYNC_MAX_SECONDS/);
      expect(() => lipsyncFromEnv({ LIPSYNC_PROVIDER: "command" })).toThrow(/LIPSYNC_CMD/);
      expect(() => lipsyncFromEnv({})).toThrow(NotConfiguredError);
    });
  });

  it("createProviders(live) wires image / video / lipsync from env and refuses without keys", () => {
    const base = { GEMINI_API_KEY: "g", GROQ_API_KEY: "q" };
    const talking = new MockTalking();
    const p = createProviders({ mode: "live", env: { ...base, FAL_KEY: "f" }, overrides: { talking } });
    expect(p.video).toBeInstanceOf(SeedanceVideo);
    expect(p.image).toBeInstanceOf(FalNanoBananaImage);
    expect(p.lipsync).toBeInstanceOf(FalKlingLipsync);
    const bp = createProviders({
      mode: "live",
      env: {
        ...base,
        ARK_API_KEY: "a",
        SEEDANCE_TRANSPORT: "byteplus",
        IMAGE_PROVIDER: "seedream",
        LIPSYNC_PROVIDER: "command",
        LIPSYNC_CMD: "x {video} {audio} {out}",
      },
      overrides: { talking },
    });
    expect(bp.video.name).toBe("byteplus-seedance-2.0");
    expect(bp.image).toBeInstanceOf(SeedreamImage);
    expect(bp.lipsync).toBeInstanceOf(CommandLipsync);
    expect(() => createProviders({ mode: "live", env: base, overrides: { talking } })).toThrow(NotConfiguredError);
  });

  it("createProviders(live) on OpenRouter needs no FAL_KEY: lip-sync and talking fail only when called", async () => {
    const p = createProviders({
      mode: "live",
      env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "q", OPENROUTER_API_KEY: "o", SEEDANCE_TRANSPORT: "openrouter", IMAGE_PROVIDER: "openrouter" },
    });
    expect(p.video.name).toBe("openrouter-seedance-2.0");
    expect(p.image).toBeInstanceOf(OpenRouterImage);
    expect(p.lipsync.estimateUsd?.({ video: "", audio: "", out: "" })).toBeCloseTo(klingLipsyncCost(10), 9); // budget still plans for it
    await expect(p.lipsync.sync({ video: "v", audio: "a", out: "o" })).rejects.toThrow(/live lipsync provider is not configured: set FAL_KEY/);
    await expect(p.talking.talk({ image: "i", audio: "a", prompt: "p", out: "o" })).rejects.toBeInstanceOf(NotConfiguredError);
    // A typo is still a startup error, not a deferred one.
    expect(() =>
      createProviders({ mode: "live", env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "q", FAL_KEY: "f", LIPSYNC_PROVIDER: "kling2" } }),
    ).toThrow(/unknown "kling2"/);
  });
});
