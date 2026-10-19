import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ValidationError } from "@fal-ai/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  castCharacter,
  castCharacters,
  keyframePrompt,
  keyframeShot,
  portraitPrompt,
  ShotError,
  snapDuration,
  talkingPrompt,
  talkingShot,
  textToVideoPrompt,
} from "../src/nodes/visuals.ts";
import { VISUALS_PROMPT_VERSION } from "../src/prompts/visuals.ts";
import { clipRubric, keyframeRubric } from "../src/prompts/judge.ts";
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

/** F11: a dialogue, shot-reverse-shot. */
const MARA = {
  name: "Mara",
  look: "a woman in her fifties, silver-streaked curly hair, burgundy cardigan, thin gold reading glasses",
  voice: { gender: "female" as const, age: "older" as const, tone: "warm, tired" },
  voiceDescription: "warm low female voice, mid-50s, neutral American accent, unhurried",
};
const LEO = {
  name: "Leo",
  look: "a man in his early twenties, curly brown hair, thin silver glasses, a navy hoodie with frayed cuffs",
  voice: { gender: "male" as const, age: "young" as const, tone: "anxious" },
  voiceDescription: "soft, anxious young male voice, early twenties, light American accent, quick",
};
const DUO: Script = Script.parse({
  promptVersion: "test",
  title: "The envelope",
  logline: "A mother gives her son an envelope.",
  setting: "kitchen table at night, one warm pendant lamp",
  characters: [MARA, LEO],
  shots: [
    { id: "s1", camera: "close-up", visual: "Mara slides an envelope across the table", motion: "she lets go of it slowly", emotion: "calm, sad", line: "Open it after I leave.", seconds: 5, speaker: "Mara", onScreen: ["Mara"] },
    { id: "s2", camera: "close-up", visual: "Leo looks up from the envelope", motion: "he raises his eyes", emotion: "scared", line: "Mom, are you sick?", seconds: 5, speaker: "Leo", onScreen: ["Leo"] },
  ],
  quotedLines: ["Open it after I leave.", "Mom, are you sick?"],
});
const D1 = DUO.shots[0]!;
const D2 = DUO.shots[1]!;

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
    expect(p).toContain(SCRIPT.characters[0]!.look);
    expect(p).toContain(SCRIPT.setting);
    expect(p).toContain("medium close-up");
    expect(p).toContain("quiet, hurt");
    expect(p.toLowerCase()).toContain("photoreal, cinematic, vertical 9:16, face clearly visible, mouth closed, no text, no watermark");
  });

  it("talkingPrompt puts the line verbatim in braces, with quotes and apostrophes intact", () => {
    const line = `He said "don't" twice, and I didn't listen — Dan's fault.`;
    const shot: Shot = { ...S1, line };
    const p = talkingPrompt(shot, SCRIPT);
    expect(p).toContain(`Dan looks toward the camera and, quiet, hurt, says in English: {${line}}`);
    expect(p).toMatch(/locked-off camera/i);
    // The old wording repeated and annotated the line, which the guide says can trigger burned-in subtitles.
    expect(p).not.toMatch(/exactly these words/i);
    expect(p.split(line)).toHaveLength(2); // the line appears once
  });

  it("talkingPrompt keeps delivery tags out of the braces and in the delivery, before the line", () => {
    const p = talkingPrompt({ ...S1, line: "[whispers] I kept the watch." }, SCRIPT);
    expect(p).toContain("and, quiet, hurt, whispers, says in English: {I kept the watch.}");
    expect(p).not.toContain("[whispers]");
  });

  it("silent shot prompt asks for no speech and no music", () => {
    const p = talkingPrompt(S2, SCRIPT);
    expect(p).not.toContain("{");
    expect(p).toMatch(/^Audio policy: no speech, only quiet natural room tone; no music/);
    expect(p).toMatch(/No speech and no music of any kind\./);
    expect(p).toMatch(/Avoid generating subtitles, captions, a logo or a watermark\.$/);
  });

  it("portraitPrompt follows the official headshot spec, one view", () => {
    const p = portraitPrompt(SCRIPT);
    expect(p).toContain(
      "Front-facing close-up framed above the shoulders, the face filling about two-thirds of the frame, neutral expression, mouth closed, plain light-grey background, even soft light. Vertical portrait.",
    );
    expect(p).toContain(SCRIPT.characters[0]!.look);
    expect(p).toMatch(/not a multi-view sheet/);
    expect(portraitPrompt(DUO, "Leo")).toContain(LEO.look);
    expect(portraitPrompt(DUO, "Leo")).not.toContain(MARA.look);
    expect(() => portraitPrompt(DUO, "Nobody")).toThrow(/no character named "Nobody"/);
  });
});

describe("Seedance prompt wording (F11 acceptance 3)", () => {
  const POLICY = (name: string) =>
    `Audio policy: only ${name}'s spoken line plus quiet natural room tone; no music, background music, BGM, score, instrumental, melody, soundtrack, synth, ambient pad or stinger at any moment.`;
  const TAIL = (name: string) =>
    "Generate audio strictly according to the dialogue; do not add or remove any words; one speaker only; clean, clear, standard pronunciation. No music of any kind. " +
    "The character's face remains stable and consistent throughout, without deformation; hands anatomically correct; natural, smooth movement. " +
    `Only one ${name} in frame; no duplicate or twin. Avoid generating subtitles, captions, a logo or a watermark.`;

  it("audio policy first, constraint tail last, braces dialogue with nothing after the closing brace", () => {
    const p = talkingPrompt(D2, DUO);
    expect(p.startsWith(POLICY("Leo"))).toBe(true);
    expect(p.endsWith(TAIL("Leo"))).toBe(true);
    expect(p).toContain("Leo looks toward the camera and, scared, says in English: {Mom, are you sick?}");
    // No text after the closing brace within the same sentence: the next thing is a new sentence.
    expect(p).toMatch(/says in English: \{Mom, are you sick\?\} [A-Z]/);
    expect(p).not.toMatch(/\}[^\s]/);
    expect(p.match(/says in English: \{/g)).toHaveLength(1);
  });

  it("the speaker's voiceDescription appears verbatim in every shot they speak, and only the speaker's", () => {
    expect(talkingPrompt(D1, DUO)).toContain(`Voice: ${MARA.voiceDescription}.`);
    expect(talkingPrompt(D2, DUO)).toContain(`Voice: ${LEO.voiceDescription}.`);
    expect(talkingPrompt(D2, DUO)).not.toContain(MARA.voiceDescription);
    // Voice goes before the line: nothing annotates the dialogue after it.
    const p = talkingPrompt(D1, DUO);
    expect(p.indexOf("Voice:")).toBeLessThan(p.indexOf("says in English"));
  });

  it("a listener on screen stays silent; the audio policy still names only the speaker", () => {
    const p = talkingPrompt({ ...D1, onScreen: ["Mara", "Leo"] }, DUO);
    expect(p.startsWith(POLICY("Mara"))).toBe(true);
    expect(p).toContain("Leo listens in silence, mouth closed.");
    expect(p).toContain("Only one Mara and one Leo in frame; no duplicate or twin.");
  });

  it("judge issues go before the constraint tail, which stays last", () => {
    const p = talkingPrompt(D2, DUO, { issues: ["six fingers"] });
    expect(p).toContain("Avoid these problems from the previous attempt: six fingers.");
    expect(p.endsWith(TAIL("Leo"))).toBe(true);
  });

  it("refs: @Image N (Name) numbered in upload order, speaker's portrait first, keyframe as the opening frame", () => {
    const p = textToVideoPrompt({ ...D2, onScreen: ["Mara", "Leo"] }, DUO, { refs: ["Leo", "Mara", "opening frame"] });
    expect(p.startsWith(POLICY("Leo"))).toBe(true);
    expect(p.endsWith(TAIL("Leo").replace("The character's face remains", "Each character's face remains").replace("Only one Leo", "Only one Leo and one Mara"))).toBe(true);
    expect(p).toContain("@Image 1 (Leo) is the face reference for Leo: keep Leo's facial features, hair and outfit from @Image 1 (Leo) exactly.");
    expect(p).toContain("@Image 2 (Mara) is the face reference for Mara");
    expect(p).toContain("@Image 3 (opening frame) is the first-frame constraint: start from this composition, setting and outfit.");
    expect(p).toContain("@Image 1 (Leo) looks toward the camera and, scared, says in English: {Mom, are you sick?}");
    expect(p).toContain("@Image 2 (Mara) listens in silence");
    // A noun right after every tag (sd2-pe): never "@Image 1 runs…".
    expect(p).not.toMatch(/@Image \d+(?! \()/);
    expect(p).not.toMatch(/Reference image/);
  });

  it("text-only (no refs) names nobody by tag", () => {
    const p = textToVideoPrompt(D2, DUO);
    expect(p).not.toContain("@Image");
    expect(p).toContain("Leo looks toward the camera");
    expect(p).toContain(LEO.look);
  });

  it("keyframes describe everyone on screen, speaker first", () => {
    const p = keyframePrompt({ ...D2, onScreen: ["Mara", "Leo"] }, DUO);
    expect(p.indexOf(LEO.look)).toBeLessThan(p.indexOf(MARA.look));
    expect(p).toContain("Same people as the reference images, in order: Leo, Mara.");
  });

  it("the prompt version was bumped", () => {
    // Pinned to the current version: F12 bumped v3→v4, F13 (multi-cut shots) bumped v4→v5, the opening-cut keyframe v5→v6.
    expect(VISUALS_PROMPT_VERSION).toBe("visuals-v6");
  });
});

describe("two characters (F11)", () => {
  it("cast makes one portrait per character; keyframe refs are the on-screen portraits, speaker first, then the previous keyframe", async () => {
    const dir = fresh();
    const image = new MockImage();
    const { portraits, attempts } = await castCharacters(DUO, { image, dir });
    expect(Object.keys(portraits)).toEqual(["Mara", "Leo"]);
    expect(portraits.Mara).not.toBe(portraits.Leo);
    expect(image.calls.map((c) => c.prompt)).toEqual([portraitPrompt(DUO, "Mara"), portraitPrompt(DUO, "Leo")]);
    expect(attempts.map((a) => a.stage)).toEqual(["portrait", "portrait"]);

    const both = { ...D1, onScreen: ["Mara", "Leo"] };
    const k1 = await keyframeShot(both, DUO, portraits, undefined, { image, dir });
    const k2 = await keyframeShot(D2, DUO, portraits, k1.path, { image, dir });
    expect(image.calls[2]!.refs).toEqual([portraits.Mara, portraits.Leo]);
    expect(image.calls[3]!.refs).toEqual([portraits.Leo, k1.path]);

    // Content-addressed per character: casting again makes no calls.
    const again = new MockImage();
    await castCharacters(DUO, { image: again, dir });
    expect(again.calls).toHaveLength(0);
    expect(k2.path).not.toBe(k1.path);
  });

  it("refs mode: the speaker's portrait is reference 1, then other on-screen portraits, then the keyframe (acceptance 4)", async () => {
    const dir = fresh();
    const image = new MockImage();
    const { portraits } = await castCharacters(DUO, { image, dir });
    const shot = { ...D2, onScreen: ["Mara", "Leo"] };
    const kf = (await keyframeShot(shot, DUO, portraits, undefined, { image, dir })).path;
    const realFace = "InputImageSensitiveContentDetected.PrivacyInformation: the input image may contain real person";
    const r = rig(new MockVideo({ faults: [{ call: 0, reject: realFace }] }));
    const out = await talkingShot(shot, kf, { script: DUO, dir, portrait: portraits, ...r });

    expect(out.verbatim?.pass).toBe(true);
    expect(r.video.calls).toHaveLength(2);
    const refs = r.video.calls[1]!.refs!;
    expect(refs).toEqual([portraits.Leo, portraits.Mara, kf]);
    expect(r.video.calls[1]!.prompt).toBe(textToVideoPrompt(shot, DUO, { refs: ["Leo", "Mara", "opening frame"] }));
  }, 60_000);

  it("the fallback voice is the speaker's", async () => {
    const dir = fresh();
    const image = new MockImage();
    const { portraits } = await castCharacters(DUO, { image, dir });
    const kf = (await keyframeShot(D2, DUO, portraits, undefined, { image, dir })).path;
    const r = rig(new MockVideo({ nativeSpeech: false }));
    await talkingShot(D2, kf, { script: DUO, dir, ...r });
    expect(r.tts.calls).toHaveLength(1);
    expect(r.tts.calls[0]!.voice).toMatch(/^male/);
  }, 60_000);
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

  it("keyframe refused as a real person → reference-to-video (portrait + keyframe); later takes keep it", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const portrait = (await castCharacter(SCRIPT, { image: new MockImage(), dir })).path;
    const realFace = "InputImageSensitiveContentDetected.PrivacyInformation: the input image may contain real person";
    // Call 0 is refused; call 1 (references) mishears, so a second native take (call 2) is needed.
    const r = rig(new MockVideo({ faults: [{ call: 0, reject: realFace }, { call: 1, say: "I kept the wash. I kept everything." }] }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, portrait, ...r });

    expect(shot.via).toBe("native");
    expect(shot.verbatim?.pass).toBe(true);
    expect(r.video.calls).toHaveLength(3);
    expect(r.video.calls[0]).not.toHaveProperty("textOnly");
    expect(r.video.calls[0]).not.toHaveProperty("refs");
    for (const c of r.video.calls.slice(1)) {
      expect(c.textOnly).toBe(true);
      expect(c.refs).toEqual([portrait, kf]);
      // Without a first frame, the prompt itself carries the look and the setting, and names the references.
      expect(c.prompt).toContain(SCRIPT.characters[0]!.look);
      expect(c.prompt).toContain(SCRIPT.setting);
      expect(c.prompt).toMatch(/@Image 1 \(Dan\) is the face reference for Dan.*@Image 2 \(opening frame\) is the first-frame constraint/);
    }
    expect(r.video.calls[0]!.prompt).not.toContain(SCRIPT.setting);
    expect(shot.attempts[0]).toMatchObject({ stage: "video", n: 1, ok: false, reason: expect.stringMatching(/keyframe refused.*real person.*reference-to-video/) });
  }, 60_000);

  it("portrait + keyframe refused → portraits only (live 2026-10-19); then text-to-video", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const portrait = (await castCharacter(SCRIPT, { image: new MockImage(), dir })).path;
    const rp = "may contain real person";
    const two = rig(new MockVideo({ faults: [{ call: 0, reject: rp }, { call: 1, reject: rp }] }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, portrait, ...two });
    expect(shot.verbatim?.pass).toBe(true);
    expect(two.video.calls.map((c) => c.refs ?? [])).toEqual([[], [portrait, kf], [portrait]]);
    expect(two.video.calls[2]!.textOnly).toBe(true);
    expect(two.video.calls[2]!.prompt).toMatch(/@Image 1 \(Dan\) is the face reference for Dan/);
    expect(two.video.calls[2]!.prompt).not.toMatch(/opening frame/);
    expect(shot.attempts[1]).toMatchObject({ ok: false, reason: expect.stringMatching(/reference images refused.*portraits only/) });

    const dir3 = fresh();
    const kf3 = await keyframeFor(dir3);
    const three = rig(new MockVideo({ faults: [0, 1, 2].map((call) => ({ call, reject: rp })) }));
    const last = await talkingShot(S1, kf3, { script: SCRIPT, dir: dir3, maxNative: 2, portrait, ...three });
    expect(last.verbatim?.pass).toBe(true);
    expect(three.video.calls.map((c) => [c.textOnly ?? false, c.refs?.length ?? 0])).toEqual([[false, 0], [true, 2], [true, 1], [true, 0]]);
    expect(three.video.calls[3]!.prompt).not.toMatch(/@Image/);
  }, 60_000);

  it("a redo of a take whose clip came from a lower rung reuses it without asking the refused rungs again", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const portrait = (await castCharacter(SCRIPT, { image: new MockImage(), dir })).path;
    const rp = "may contain real person";
    const paid = rig(new MockVideo({ faults: [{ call: 0, reject: rp }, { call: 1, reject: rp }] }));
    const first = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, portrait, ...paid });
    expect(paid.video.calls).toHaveLength(3);
    const again = rig(new MockVideo());
    const redo = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, portrait, ...again });
    expect(again.video.calls).toHaveLength(0);
    expect(redo.path).toBe(first.path);
  }, 60_000);

  it("without a portrait: references refused too → text-to-video; a third refusal is not retried", async () => {
    const rp = "may contain real person";

    const dir2 = fresh();
    const kf2 = await keyframeFor(dir2);
    const bad = rig(new MockVideo({ faults: [0, 1, 2].map((call) => ({ call, reject: rp })) }));
    const err = await talkingShot(S1, kf2, { script: SCRIPT, dir: dir2, maxNative: 2, ...bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotError);
    expect(bad.video.calls).toHaveLength(3);
    expect((err as ShotError).attempts.map((a) => a.ok)).toEqual([false, false, false]);
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

  it("speech the model adds to a silent shot is heard and its audio dropped (live 2026-10-19)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, say: "I'm sorry, I'm sorry." }] }));
    const shot = await talkingShot(S2, kf, { script: SCRIPT, dir, ...r });
    expect(r.video.calls).toHaveLength(1);
    expect(r.transcribe).toHaveBeenCalledTimes(1);
    expect(shot.via).toBe("silent");
    expect(shot.hasAudio).toBe(false); // assembly lays silence here
    expect(shot.attempts.at(-1)).toMatchObject({ stage: "listen", reason: expect.stringMatching(/speech heard in a silent shot \("I'm sorry, I'm sorry\.?"\); its audio replaced with silence/) });
    expect(r.tts.calls).toHaveLength(0);
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
      // The model id is the endpoint called (F17: the trace's generation model).
      expect(r).toEqual({ path: out, seconds: 7.04, hasAudio: false, costUsd: 7 * 0.3034, model: "bytedance/seedance-2.0/image-to-video" });
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

describe("wide shots (F12)", () => {
  const WIDE: Shot = { ...S1, camera: "wide shot", visual: "Dan stands at the far edge of the roof, the city towering behind him" };
  const LOOK = SCRIPT.characters[0]!.look;

  it("wide keyframe: no face close-up demand, the identity cues named, the place dominates (acceptance 5)", () => {
    const p = keyframePrompt(WIDE, SCRIPT);
    expect(p).not.toMatch(/face clearly visible/i);
    expect(p).toContain(`Dan is small in frame, full figure visible, recognisable by ${LOOK}`);
    expect(p).toMatch(/the place dominates/);
    expect(p).toMatch(/lower third/);
    // Close sizes are unchanged.
    expect(keyframePrompt(S1, SCRIPT)).toContain("face clearly visible, mouth closed");
  });

  it("wide talking prompt: `small in frame, says in English: {…}`, no looking at the camera, F11 policy and tail kept (acceptance 5)", () => {
    const p = talkingPrompt(WIDE, SCRIPT);
    expect(p).toContain(`Dan, small in frame, says in English: {${LINE}}`);
    expect(p).not.toMatch(/looks toward the camera/);
    expect(p).toMatch(/^Audio policy: only Dan's spoken line/);
    expect(p).toMatch(/Avoid generating subtitles, captions, a logo or a watermark\.$/);
    expect(p).not.toMatch(/\}[^\s]/);
    // Order: shot size, one camera move, subject with identity cues, action, then the audio.
    const at = (s: string) => p.indexOf(s);
    expect(at("Shot size: wide shot.")).toBeGreaterThan(0);
    expect(at("Shot size: wide shot.")).toBeLessThan(at("Locked-off camera, or one slow crane up or pull-back"));
    expect(at("pull-back")).toBeLessThan(at(`recognisable by ${LOOK}`));
    expect(at(`recognisable by ${LOOK}`)).toBeLessThan(at(WIDE.visual));
    expect(at(WIDE.visual)).toBeLessThan(at("says in English"));
    expect(p).not.toMatch(/push-in/);
    // The text-to-video variant follows the same rules.
    const t = textToVideoPrompt(WIDE, SCRIPT);
    expect(t).toContain(`Dan, small in frame, says in English: {${LINE}}`);
    expect(t).not.toMatch(/looks toward the camera/);
  });

  it("close-up talking prompt keeps the F11 sentence and a push-in", () => {
    const p = talkingPrompt(S1, SCRIPT);
    expect(p).toContain(`Dan looks toward the camera and, quiet, hurt, says in English: {${LINE}}`);
    expect(p).toContain("Shot size: medium close-up. Locked-off camera with at most a slow push-in.");
  });

  it("judge rubrics for a wide shot have no lip-sync or mouth item; close shots keep them (acceptance 5)", () => {
    const k = keyframeRubric(WIDE, SCRIPT);
    expect(k).not.toMatch(/lip-sync/i);
    expect(k).toMatch(/recognisable by its look \(hair, outfit, silhouette\), anatomically whole/);
    expect(k).toMatch(/setting matches and dominates/);
    expect(keyframeRubric(S1, SCRIPT)).toMatch(/large and sharp enough for lip-sync/);
    const c = clipRubric(WIDE, SCRIPT);
    expect(c).not.toMatch(/mouth/i);
    expect(c).toMatch(/duplicated, merging or melting figures/);
    expect(c).toMatch(/Stable architecture/);
    expect(clipRubric(S1, SCRIPT)).toMatch(/Mouth region intact/);
  });

  async function wideKeyframe(dir: string): Promise<string> {
    const image = new MockImage();
    const portrait = await castCharacter(SCRIPT, { image, dir });
    return (await keyframeShot(WIDE, SCRIPT, portrait.path, undefined, { image, dir })).path;
  }

  it("native speech fails twice on a wide shot → verified TTS laid over the clip, no lip-sync call (acceptance 6)", async () => {
    const dir = fresh();
    const kf = await wideKeyframe(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, say: "I kept the clock. I kept everything." }, { call: 1, say: "I kept it." }] }));
    const shot = await talkingShot(WIDE, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(r.video.calls).toHaveLength(2);
    expect(r.tts.calls).toHaveLength(1);
    expect(r.lipsync.calls).toHaveLength(0);
    expect(shot).toMatchObject({ via: "voiceover", hasAudio: true, verbatim: { pass: true, wer: 0 } });
    expect(shot.path).toMatch(/voiceover-s1-[0-9a-f]+\.mp4$/);
    // Laid on the closer native clip (1 sub beats 4 dels), keeping its length.
    const base = await probe(finalPath(r.video.calls[0]!.out));
    expect(shot.seconds).toBeCloseTo(base.seconds, 1);
    const story = shot.attempts.map((a) => `${a.stage}:${a.n}:${a.ok}`);
    expect(story).toEqual(["video:1:false", "video:2:false", "fallback:1:true", "voice:1:true", "voiceover:1:true"]);
    expect(shot.attempts[2]!.reason).toMatch(/failed the verbatim gate 2×.*voice-over without lip-sync \(wide shot/);
    for (const a of shot.attempts) expect(Attempt.parse(a).shotId).toBe("s1");
  }, 60_000);

  it("on a close-up the same failure still goes TTS + lip-sync (acceptance 6)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, say: "I kept the clock. I kept everything." }, { call: 1, say: "I kept it." }] }));
    const shot = await talkingShot(S1, kf, { script: SCRIPT, dir, maxNative: 2, ...r });
    expect(r.lipsync.calls).toHaveLength(1);
    expect(shot.via).toBe("lipsync");
    expect(shot.attempts.map((a) => a.stage)).not.toContain("voiceover");
  }, 60_000);

  it("a voice-over the gate mis-hears fails loudly, never passes", async () => {
    const dir = fresh();
    const kf = await wideKeyframe(dir);
    const video = new MockVideo({ faults: [{ call: 0, say: "nothing like it" }] });
    // ASR calls: 0 = native clip, 1 = TTS take (passes), 2 = voice-over clip (mis-heard).
    const asr = new MockAsr({ faults: [{ call: 2, replace: { watch: "wash" } }] });
    const lipsync = new MockLipsync();
    const err = await talkingShot(WIDE, kf, { script: SCRIPT, dir, maxNative: 1, video, asr, tts: new MockTts(), lipsync }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerbatimError);
    expect(lipsync.calls).toHaveLength(0);
    expect((err as VerbatimError).attempts.at(-1)).toMatchObject({ stage: "voiceover", ok: false });
  }, 60_000);
});

describe("cuts inside a clip (F13)", () => {
  // Speaker → an insert of the watch (nobody on screen): the line runs over the second cut.
  const CUT: Shot = {
    ...S1,
    cuts: [
      { camera: "medium close-up", visual: S1.visual, onScreen: ["Dan"] },
      { camera: "close-up", visual: "the old watch ticking in Dan's palm", onScreen: [] },
    ],
  };
  const count = (p: string, s: string) => p.split(s).length - 1;

  it("video prompt: audio policy first, Shot 1 … Shot 2 in order, the dialogue once after the list, tail last (acceptance 5)", () => {
    for (const p of [talkingPrompt(CUT, SCRIPT), textToVideoPrompt(CUT, SCRIPT)]) {
      expect(p).toMatch(/^Audio policy: only Dan's spoken line/);
      expect(p).toMatch(/Avoid generating subtitles, captions, a logo or a watermark\.$/);
      const one = p.indexOf("Shot 1: medium close-up");
      const two = p.indexOf("Shot 2: close-up");
      expect(one).toBeGreaterThan(0);
      expect(two).toBeGreaterThan(one);
      expect(count(p, "says in English")).toBe(1);
      expect(count(p, `{${LINE}}`)).toBe(1);
      expect(p.indexOf(`Dan says in English: {${LINE}}`)).toBeGreaterThan(two);
      expect(p).toMatch(/the line continues over the cuts/);
      expect(p).not.toMatch(/\}[^\s]/);
    }
  });

  it("speaker in every cut → no 'continues over the cuts'; the keyframe shows the first cut", () => {
    const both: Shot = { ...CUT, cuts: [CUT.cuts![0]!, { camera: "close-up", visual: "Dan's eyes, wet", onScreen: ["Dan"] }] };
    expect(talkingPrompt(both, SCRIPT)).not.toMatch(/continues over the cuts/);
    const opening: Shot = {
      ...CUT,
      camera: "wide shot",
      cuts: [{ camera: "wide shot", visual: "Dan tiny on the roof edge", onScreen: ["Dan"] }, CUT.cuts![0]!],
    };
    const k = keyframePrompt(opening, SCRIPT);
    expect(k).toContain("Shot: wide shot. Dan tiny on the roof edge.");
    expect(k).not.toMatch(/face clearly visible/);
  });

  // Human note: the keyframe is the first frame, so it shows the opening cut only (its cast, size and visual).
  const LISTENER_FIRST: Shot = {
    ...D1,
    camera: "medium shot",
    seconds: 8,
    onScreen: ["Mara", "Leo"],
    cuts: [
      { camera: "medium shot", visual: "Leo listens at the table, eyes down", onScreen: ["Leo"] },
      { camera: "close-up", visual: "Mara's face under the lamp", onScreen: ["Mara"] },
    ],
  };

  it("first cut shows only the listener → keyframe prompt, rubric and refs name only the listener", async () => {
    const k = keyframePrompt(LISTENER_FIRST, DUO);
    expect(k).toContain(`Leo, ${LEO.look}.`);
    expect(k).not.toContain(MARA.look);
    expect(k).not.toMatch(/Mara/);
    expect(k).toContain("Same person as the reference image.");
    expect(k).toContain("Shot: medium shot. Leo listens at the table, eyes down.");
    expect(k).toMatch(/face clearly visible/);

    const r = keyframeRubric(LISTENER_FIRST, DUO);
    expect(r).toContain(`4. It matches the character: ${LEO.look}`);
    expect(r).not.toMatch(/Mara/);

    const dir = fresh();
    const image = new MockImage();
    const { portraits } = await castCharacters(DUO, { image, dir });
    await keyframeShot(LISTENER_FIRST, DUO, portraits, undefined, { image, dir });
    expect(image.calls.at(-1)!.refs).toEqual([portraits.Leo]);

    // The video call still knows both: the speaker's line and identity cues per cut.
    const v = talkingPrompt(LISTENER_FIRST, DUO);
    expect(v).toContain(`Leo (${LEO.look})`);
    expect(v).toContain(`Mara (${MARA.look})`);
    expect(v).toContain("Mara says in English: {Open it after I leave.}");
  });

  it("speaker in the first cut leads the keyframe cast; a wide first cut gets the wide wording in prompt and rubric", () => {
    const wideFirst: Shot = {
      ...LISTENER_FIRST,
      camera: "wide shot",
      cuts: [
        { camera: "wide shot", visual: "the kitchen, both at the table, small under the lamp", onScreen: ["Leo", "Mara"] },
        { camera: "close-up", visual: "Mara's face under the lamp", onScreen: ["Mara"] },
      ],
    };
    const k = keyframePrompt(wideFirst, DUO);
    expect(k).toContain("Same people as the reference images, in order: Mara, Leo.");
    expect(k.indexOf(MARA.look)).toBeLessThan(k.indexOf(LEO.look));
    expect(k).toMatch(/Mara is small in frame, full figure visible/);
    expect(k).not.toMatch(/face clearly visible/);
    const r = keyframeRubric(wideFirst, DUO);
    expect(r).toMatch(/^Judge this keyframe for a vertical 9:16 wide shot/);
    expect(r).toMatch(/It shows 2 people, each the same person as their reference portrait, in order: Mara .*; Leo/);
  });

  it("native speech fails on a shot with cuts → voice-over, no lip-sync call (acceptance 6)", async () => {
    const dir = fresh();
    const kf = await keyframeFor(dir);
    const r = rig(new MockVideo({ faults: [{ call: 0, say: "I kept the clock. I kept everything." }, { call: 1, say: "I kept it." }] }));
    const shot = await talkingShot(CUT, kf, { script: SCRIPT, dir, maxNative: 2, ...r });

    expect(r.video.calls).toHaveLength(2);
    expect(r.lipsync.calls).toHaveLength(0);
    expect(shot).toMatchObject({ via: "voiceover", hasAudio: true, verbatim: { pass: true, wer: 0 } });
    const fallback = shot.attempts.find((a) => a.stage === "fallback")!;
    expect(fallback.reason).toMatch(/voice-over without lip-sync \(the clip has cuts/);
    expect(fallback.provider).toBe(r.tts.name);
  }, 60_000);
});
