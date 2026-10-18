/**
 * Contracts between stages. Every stage boundary parses through one of these, so a model that returns
 * a bad shape or an impossible duration fails here, deterministically, with a message we can feed back.
 */
import { z } from "zod";

const nonEmpty = (what: string) => z.string().trim().min(1, `${what} must not be empty`);

export const Character = z.object({
  name: nonEmpty("name"),
  /** Concrete visual description (age, hair, face, wardrobe) an image model can render consistently. */
  look: nonEmpty("look"),
  voice: z.object({
    gender: z.enum(["female", "male"]),
    age: z.enum(["young", "adult", "older"]),
    tone: nonEmpty("voice tone"),
  }),
});
export type Character = z.infer<typeof Character>;

/** Seedance 2.0 accepts 4–15 s clips (docs/research/video-models.md, specs/F05); one shot is one clip. */
export const SHOT_SECONDS = { min: 4, max: 15 } as const;
export const SCRIPT_SECONDS = { min: 8, max: 30 } as const;

export const Shot = z.object({
  id: z.enum(["s1", "s2"]),
  camera: z.enum(["close-up", "medium close-up", "medium"]),
  visual: nonEmpty("visual"),
  motion: nonEmpty("motion"),
  emotion: nonEmpty("emotion"),
  /** Exact text spoken in this shot; "" for a silent shot. Not trimmed: it is the verbatim reference. */
  line: z.string(),
  seconds: z
    .number()
    .min(SHOT_SECONDS.min, `shot seconds must be ${SHOT_SECONDS.min}–${SHOT_SECONDS.max}`)
    .max(SHOT_SECONDS.max, `shot seconds must be ${SHOT_SECONDS.min}–${SHOT_SECONDS.max}`),
});
export type Shot = z.infer<typeof Shot>;

const ScriptFields = z.object({
  promptVersion: nonEmpty("promptVersion"),
  title: nonEmpty("title"),
  logline: nonEmpty("logline"),
  setting: nonEmpty("setting"),
  character: Character,
  // Count is checked in superRefine so the message can say how many we got.
  shots: z.array(Shot),
  /** Lines quoted in the idea, as extracted by code (extractQuotedLines), not by the model. */
  quotedLines: z.array(z.string()),
});

/**
 * What the LLM is asked to return: the script minus the fields code owns (promptVersion, quotedLines).
 * Built from the unrefined object because zod refuses .omit() on a refined schema.
 */
export const ScriptDraft = ScriptFields.omit({ promptVersion: true, quotedLines: true });
export type ScriptDraft = z.infer<typeof ScriptDraft>;

export const Script = ScriptFields
  .superRefine((s, ctx) => {
    const n = s.shots.length;
    if (n < 1 || n > 2) {
      ctx.addIssue({ code: "custom", path: ["shots"], message: `a script has 1–2 shots, got ${n}` });
      return;
    }
    s.shots.forEach((shot, i) => {
      const want = `s${i + 1}`;
      if (shot.id !== want) {
        ctx.addIssue({
          code: "custom",
          path: ["shots", i, "id"],
          message: `shot ${i + 1} must have id "${want}", got "${shot.id}"`,
        });
      }
    });
    const total = s.shots.reduce((sum, shot) => sum + shot.seconds, 0);
    if (total < SCRIPT_SECONDS.min || total > SCRIPT_SECONDS.max) {
      ctx.addIssue({
        code: "custom",
        path: ["shots"],
        message: `total duration ${total} s is outside ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} s`,
      });
    }
    if (!s.shots.some((shot) => shot.line.trim() !== "")) {
      ctx.addIssue({
        code: "custom",
        path: ["shots"],
        message: "at least one shot must have a non-empty spoken line",
      });
    }
  });
export type Script = z.infer<typeof Script>;

export const TranscriptWord = z
  .object({ word: z.string(), start: z.number().min(0), end: z.number().min(0) })
  .refine((w) => w.end >= w.start, { message: "end must be >= start", path: ["end"] });
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.object({ text: z.string(), words: z.array(TranscriptWord) });
export type Transcript = z.infer<typeof Transcript>;

export const VerbatimOp = z.object({
  type: z.enum(["sub", "del", "ins"]),
  expected: z.string().optional(),
  heard: z.string().optional(),
});
export type VerbatimOp = z.infer<typeof VerbatimOp>;

export const VerbatimResult = z
  .object({
    /** Normalised expected text (what the ops refer to). */
    expected: z.string(),
    /** Normalised heard text. */
    heard: z.string(),
    wer: z.number().min(0),
    ops: z.array(VerbatimOp),
    pass: z.boolean(),
    /**
     * Heard tokens the gate did not count, with why visible in the token itself: bracketed non-speech ("(laughs)")
     * and, when the line carries a laugh tag, laughter ("ha"). Reported so the attempt can log them (F10).
     */
    ignored: z.array(z.string()).optional(),
  })
  // The gate must not be forgeable by a hand-built result.
  .refine((r) => r.pass === (r.wer === 0) && r.pass === (r.ops.length === 0), {
    message: "pass must equal wer === 0 (and no ops)",
    path: ["pass"],
  });
export type VerbatimResult = z.infer<typeof VerbatimResult>;

/** Where speech sits inside a file, from ASR word timestamps (seconds). */
export const SpeechWindow = z
  .object({ speechStart: z.number().min(0), speechEnd: z.number().min(0) })
  .refine((w) => w.speechEnd >= w.speechStart, { message: "speechEnd must be >= speechStart", path: ["speechEnd"] });
export type SpeechWindow = z.infer<typeof SpeechWindow>;

/** A voice track that has passed the verbatim gate (F04 fallback voice; F05 lip-syncs it onto the video). */
export const VoiceTrack = z
  .object({
    path: nonEmpty("path"),
    seconds: z.number().positive(),
    speechStart: z.number().min(0),
    speechEnd: z.number().min(0),
    verbatim: VerbatimResult,
  })
  .refine((v) => v.speechStart < v.speechEnd && v.speechEnd <= v.seconds + 0.5, {
    message: "speech window must be non-empty and inside the track",
    path: ["speechEnd"],
  })
  .refine((v) => v.verbatim.pass, { message: "a voice track must have passed the verbatim gate", path: ["verbatim"] });
export type VoiceTrack = z.infer<typeof VoiceTrack>;

export const Attempt = z.object({
  stage: nonEmpty("stage"),
  shotId: z.enum(["s1", "s2"]).optional(),
  n: z.number().int().min(1),
  provider: nonEmpty("provider"),
  ok: z.boolean(),
  /** Why it failed or why a retry/fallback happened. No silent fallbacks. */
  reason: z.string().optional(),
  costUsd: z.number().min(0),
  ms: z.number().min(0),
  /** Quality judge score (1–10) on stage "judge" attempts (F07). */
  score: z.number().int().min(1).max(10).optional(),
});
export type Attempt = z.infer<typeof Attempt>;

/**
 * What a VLM judge returns (F07). Only what a model can judge; code computes durations, words and formats.
 * A reply that fails this schema is a judge failure, never a pass.
 */
export const JudgeVerdict = z.object({
  score: z.number().int().min(1).max(10),
  issues: z.array(z.string()),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const FinalVideo =z.object({
  path: nonEmpty("path"),
  seconds: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
});
export type FinalVideo = z.infer<typeof FinalVideo>;

/** One finished shot as the graph keeps it (F06): the clip, where its words came from, where they sit. */
export const ShotOutput = z.object({
  path: nonEmpty("path"),
  seconds: z.number().positive(),
  hasAudio: z.boolean(),
  /** native = the video model spoke; fallback = verified TTS + lip-sync; silent = no line in this shot. */
  audio: z.enum(["native", "fallback", "silent"]),
  speechStart: z.number().min(0).optional(),
  speechEnd: z.number().min(0).optional(),
  verbatim: VerbatimResult.optional(),
  /** Judge scores (1–10) of the keyframe and clip that were kept (F07). Absent = not judged, or the judge failed. */
  keyframeScore: z.number().int().min(1).max(10).optional(),
  clipScore: z.number().int().min(1).max(10).optional(),
  /** No attempt passed the quality bar and the best one was kept: a human should look before publishing. */
  needsReview: z.boolean().optional(),
});
export type ShotOutput = z.infer<typeof ShotOutput>;

/** What the final gate compared, as plain text (not normalised), so a human can read the miss. */
export const SpokenText = z.object({ expected: z.string(), heard: z.string() });
export type SpokenText = z.infer<typeof SpokenText>;

export const RunManifest = z.object({
  runId: nonEmpty("runId"),
  idea: nonEmpty("idea"),
  mode: z.enum(["mock", "live"]),
  createdAt: z.iso.datetime(),
  script: Script.optional(),
  // partialRecord: zod 4's record over an enum demands every key, and a failed run may have only s1.
  shots: z.partialRecord(z.enum(["s1", "s2"]), ShotOutput).optional(),
  attempts: z.array(Attempt),
  costUsd: z.number().min(0),
  final: FinalVideo.optional(),
  verbatim: VerbatimResult.optional(),
  spoken: SpokenText.optional(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type RunManifest = z.infer<typeof RunManifest>;

/** One line per issue, "path: message" — short enough to feed back to a model as a retry reason. */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}
