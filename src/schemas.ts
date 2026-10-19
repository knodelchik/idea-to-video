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
  /**
   * One sentence (timbre, age, accent, pace), repeated verbatim in every video prompt where this character speaks:
   * the Seedance guide reports voice matching improves "significantly" with it (docs/research/seedance-playbook.md §4).
   */
  voiceDescription: nonEmpty("voiceDescription"),
});
export type Character = z.infer<typeof Character>;

/** A script has 1–2 characters (F11): one, or two in a dialogue (shot-reverse-shot). */
export const MAX_CHARACTERS = 2;

/** Seedance 2.0 accepts 4–15 s clips (docs/research/video-models.md, specs/F05); one shot is one clip. */
export const SHOT_SECONDS = { min: 4, max: 15 } as const;
export const SCRIPT_SECONDS = { min: 8, max: 30 } as const;

/** Up to four shots (F12): a storyboard idea may have up to four beats, one shot each. */
export const MAX_SHOTS = 4;
export const ShotId = z.enum(["s1", "s2", "s3", "s4"]);
export type ShotId = z.infer<typeof ShotId>;

/** Standard shot-size words (the Seedance guides use them; one size per shot), widest first. */
export const CAMERAS = ["extreme wide shot", "wide shot", "full shot", "medium shot", "medium close-up", "close-up"] as const;
export type Camera = (typeof CAMERAS)[number];
export const Camera = z.preprocess(
  // Pre-F12 scripts said "medium"; it is the standard "medium shot".
  (v) => (v === "medium" ? "medium shot" : v),
  z.enum(CAMERAS),
);

/** The character is small in frame: lips can't be read, identity comes from hair, outfit and silhouette. */
export const isWide = (camera: Camera): boolean =>
  camera === "extreme wide shot" || camera === "wide shot" || camera === "full shot";

/**
 * Blocking (F18): where each on-screen person stands, where they go and who speaks, so the video model stages the
 * story instead of guessing it (live 2026-10-19: "advances toward the gate" rendered as walking away from it).
 */
export const POSITIONS = ["foreground", "midground", "background"] as const;
export const SIDES = ["left", "center", "right"] as const;
export const FACINGS = ["camera", "away", "left", "right"] as const;
export const DIRECTIONS = ["toward camera", "away from camera", "left to right", "right to left", "none"] as const;
export const PACES = ["real-time", "slow-motion"] as const;
export const SCREEN_DIRECTIONS = ["left to right", "right to left", "neutral"] as const;

export const Subject = z.object({
  name: nonEmpty("subject name"),
  position: z.enum(POSITIONS),
  side: z.enum(SIDES),
  facing: z.enum(FACINGS),
});
export type Subject = z.infer<typeof Subject>;

export const Place = z.object({ position: z.enum(POSITIONS), side: z.enum(SIDES) });
export type Place = z.infer<typeof Place>;

export const Movement = z
  .object({
    who: nonEmpty("movement.who"),
    direction: z.enum(DIRECTIONS),
    /** A thing visible in frame the movement heads for ("the open door of the carriage"). */
    target: z.string().trim().min(1, "movement.target must not be empty when set").optional(),
    targetPosition: Place.optional(),
    pace: z.enum(PACES),
  })
  // A goal the viewer can't locate is the castle bug: the model then picks a direction itself.
  .refine((m) => m.target === undefined || m.targetPosition !== undefined, {
    message: "movement.target is set, so movement.targetPosition ({ position, side }) must be set too",
    path: ["targetPosition"],
  });
export type Movement = z.infer<typeof Movement>;

export const Blocking = z.object({
  /** One entry per on-screen character (checked against onScreen in scriptProblems). */
  subjects: z.array(Subject),
  /** Who moves and how; null when nobody moves (a held moment, an insert). */
  movement: Movement.nullable(),
  /** The one person whose lips move here, or null. Everyone else is silent with closed lips. */
  speaking: z.string().nullable(),
});
export type Blocking = z.infer<typeof Blocking>;

export const Continuity = z.object({
  /** One sentence on how this shot follows the previous one's last moment; "start" for s1. */
  from: nonEmpty("continuity.from"),
  screenDirection: z.enum(SCREEN_DIRECTIONS),
});
export type Continuity = z.infer<typeof Continuity>;

/** Defaults for scripts written before F18: everyone mid-frame facing the camera, no movement, the speaker speaks. */
export function defaultBlocking(onScreen: string[], speaking: string | null): Blocking {
  return {
    subjects: onScreen.map((name) => ({ name, position: "midground", side: "center", facing: "camera" })),
    movement: null,
    speaking: speaking !== null && onScreen.includes(speaking) ? speaking : null,
  };
}

/**
 * One cut inside a clip (F13): Seedance renders 2–3 cuts in one call from a "Shot 1: … Shot 2: …" prompt. A cut has
 * no seconds of its own (the model paces them inside the clip). `onScreen` may be empty for an insert (an object).
 */
export const Cut = z.object({
  camera: Camera,
  visual: nonEmpty("cut visual"),
  onScreen: z.array(nonEmpty("onScreen name")),
  blocking: Blocking,
});
export type Cut = z.infer<typeof Cut>;
export const CUTS = { min: 2, max: 3 } as const;
/** A clip with cuts must leave each cut ~2–4 s (My Muse pacing, docs/research/framing-my-muse.md). */
export const CUT_SHOT_MIN_SECONDS = 6;

const ShotFields = z.object({
  id: ShotId,
  camera: Camera,
  visual: nonEmpty("visual"),
  motion: nonEmpty("motion"),
  emotion: nonEmpty("emotion"),
  /** Exact text spoken in this shot; "" for a silent shot. Not trimmed: it is the verbatim reference. */
  line: z.string(),
  seconds: z
    .number()
    .min(SHOT_SECONDS.min, `shot seconds must be ${SHOT_SECONDS.min}–${SHOT_SECONDS.max}`)
    .max(SHOT_SECONDS.max, `shot seconds must be ${SHOT_SECONDS.min}–${SHOT_SECONDS.max}`),
  /** `name` of the one character who says `line`. Required when the line is non-empty (checked on Script). */
  speaker: z.string().optional(),
  /** Names of the characters visible in the shot; the speaker must be among them. */
  onScreen: z.array(nonEmpty("onScreen name")).min(1, "onScreen must name at least one character"),
  /**
   * 2–3 cuts rendered inside this one clip (F13). The first cut is what the keyframe shows; `camera` must equal the
   * first cut's (and `visual` describes it) so readers that ignore cuts still see the opening framing.
   */
  cuts: z.array(Cut).optional(),
  /** Staging of the shot (F18); for a shot with cuts, of its opening. Each cut has its own. */
  blocking: Blocking,
  continuity: Continuity,
});

/** Cut rules, shared by Shot (so a bad shot fails at the boundary) and the script node's feedback. */
export function cutProblems(shot: z.output<typeof ShotFields>): CastProblem[] {
  const cuts = shot.cuts;
  if (cuts === undefined) return [];
  const out: CastProblem[] = [];
  const at = (...p: (string | number)[]) => ["cuts", ...p];
  if (cuts.length < CUTS.min || cuts.length > CUTS.max) {
    out.push({ path: at(), message: `shot ${shot.id}: a shot with cuts has ${CUTS.min}–${CUTS.max} cuts, got ${cuts.length}` });
    return out;
  }
  if (shot.seconds < CUT_SHOT_MIN_SECONDS) {
    out.push({ path: ["seconds"], message: `shot ${shot.id}: a shot with cuts must be at least ${CUT_SHOT_MIN_SECONDS} s, got ${shot.seconds}` });
  }
  // The keyframe is the clip's first frame and anchors identity (portrait refs, the real-face ladder): an insert with
  // nobody in it gives the video model no face to keep, so inserts are allowed only as cut 2 or 3.
  if (cuts[0]!.onScreen.length === 0) {
    out.push({
      path: at(0, "onScreen"),
      message: `shot ${shot.id}: cut 1 is the opening frame (the keyframe) and must show at least one character; put an insert (hands, an object) in cut 2 or 3`,
    });
  }
  if (cuts[0]!.camera !== shot.camera) {
    out.push({ path: ["camera"], message: `shot ${shot.id}: camera "${shot.camera}" must equal the first cut's "${cuts[0]!.camera}"` });
  }
  cuts.forEach((c, i) => {
    if (i > 0 && c.camera === cuts[i - 1]!.camera) {
      out.push({ path: at(i, "camera"), message: `shot ${shot.id}: cuts ${i} and ${i + 1} are both "${c.camera}"; never two identical sizes in a row` });
    }
    for (const who of c.onScreen) {
      if (!shot.onScreen.includes(who)) {
        out.push({ path: at(i, "onScreen"), message: `shot ${shot.id}: cut ${i + 1} shows "${who}", who is not in the shot's onScreen ${JSON.stringify(shot.onScreen)}` });
      }
    }
  });
  return out;
}

export const Shot = ShotFields.superRefine((s, ctx) => {
  for (const p of cutProblems(s)) ctx.addIssue({ code: "custom", path: p.path, message: p.message });
});
export type Shot = z.infer<typeof Shot>;

/** The framing the keyframe (first frame) shows: the first cut when the shot has cuts. */
export const openingOf = (shot: Shot): { camera: Camera; visual: string } => shot.cuts?.[0] ?? shot;

const ScriptFields = z.object({
  promptVersion: nonEmpty("promptVersion"),
  title: nonEmpty("title"),
  logline: nonEmpty("logline"),
  setting: nonEmpty("setting"),
  characters: z.array(Character),
  // Count is checked in superRefine so the message can say how many we got.
  shots: z.array(Shot),
  /** Lines quoted in the idea, as extracted by code (extractQuotedLines), not by the model. */
  quotedLines: z.array(z.string()),
  /** The continuity critic still objected on the last try (F18): the script was kept, a human should look. */
  needsReview: z.boolean().optional(),
  /** What the critic objected to, when needsReview. */
  reviewNotes: z.array(z.string()).optional(),
});

/**
 * What the LLM is asked to return: the script minus the fields code owns (promptVersion, quotedLines).
 * Built from the unrefined object because zod refuses .omit() on a refined schema.
 */
export const ScriptDraft = ScriptFields.omit({ promptVersion: true, quotedLines: true, needsReview: true, reviewNotes: true });
export type ScriptDraft = z.infer<typeof ScriptDraft>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** First script prompt that writes blocking and continuity (F18). Older scripts get defaults when parsed. */
export const BLOCKING_SINCE_PROMPT = 8;

/** A script from a prompt before script-v8, or from a hand-built/bench source that never wrote blocking. */
export function predatesBlocking(promptVersion: unknown): boolean {
  const m = typeof promptVersion === "string" ? /^script-v(\d+)$/.exec(promptVersion) : null;
  return !m || Number(m[1]) < BLOCKING_SINCE_PROMPT;
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Scripts written before F18 have no blocking or continuity. Each shot and cut gets defaultBlocking, each shot a
 * neutral screen direction ("start" for s1). Fields that are present are kept. script-v8+ scripts are left alone, so
 * a new script without blocking still fails.
 */
export function migrateBlocking(raw: unknown): unknown {
  if (!isObj(raw) || !predatesBlocking(raw.promptVersion) || !Array.isArray(raw.shots)) return raw;
  const shots = raw.shots.map((sh: unknown, i: number) => {
    if (!isObj(sh)) return sh;
    const spoken = typeof sh.line === "string" && sh.line.trim() !== "";
    const speaker = spoken && typeof sh.speaker === "string" ? sh.speaker : null;
    const cuts = Array.isArray(sh.cuts)
      ? sh.cuts.map((c: unknown) => (isObj(c) && !("blocking" in c) ? { ...c, blocking: defaultBlocking(names(c.onScreen), speaker) } : c))
      : sh.cuts;
    return {
      ...sh,
      ...(cuts !== undefined ? { cuts } : {}),
      ...("blocking" in sh ? {} : { blocking: defaultBlocking(names(sh.onScreen), speaker) }),
      ...("continuity" in sh ? {} : { continuity: { from: i === 0 ? "start" : "follows the previous shot", screenDirection: "neutral" } }),
    };
  });
  return { ...raw, shots };
}

/**
 * Scripts written before F11 had one `character` and no speaker / onScreen. They still parse: the character becomes
 * `characters[0]`, it speaks every spoken shot and is on screen in all of them, and its voiceDescription is built from
 * its voice fields. Anything that is not that legacy shape passes through untouched.
 */
export function migrateScript(raw: unknown): unknown {
  if (!isObj(raw) || !isObj(raw.character) || "characters" in raw) return raw;
  const { character: c, ...rest } = raw;
  const voice = isObj(c.voice) ? c.voice : {};
  const said = [voice.tone, voice.gender].filter((x) => typeof x === "string").join(" ");
  const voiceDescription = c.voiceDescription ?? `${said} voice${typeof voice.age === "string" ? `, ${voice.age}` : ""}`;
  const shots = Array.isArray(rest.shots)
    ? rest.shots.map((sh: unknown) => {
        if (!isObj(sh)) return sh;
        const spoken = typeof sh.line === "string" && sh.line.trim() !== "";
        return {
          ...sh,
          ...(spoken && sh.speaker === undefined ? { speaker: c.name } : {}),
          ...(sh.onScreen === undefined ? { onScreen: [c.name] } : {}),
        };
      })
    : rest.shots;
  return { ...rest, characters: [{ ...c, voiceDescription }], shots };
}

export interface CastProblem {
  path: (string | number)[];
  message: string;
}

/** Cast and speaker rules, shared by Script and the script node (which feeds them back to the model). */
export function castProblems(s: { characters: { name: string }[]; shots: z.output<typeof Shot>[] }): CastProblem[] {
  const out: CastProblem[] = [];
  const names = s.characters.map((c) => c.name);
  if (names.length < 1 || names.length > MAX_CHARACTERS) {
    out.push({ path: ["characters"], message: `a script has 1–${MAX_CHARACTERS} characters, got ${names.length}` });
  }
  const dup = names.find((x, i) => names.indexOf(x) !== i);
  if (dup !== undefined) out.push({ path: ["characters"], message: `character names must be unique; "${dup}" appears twice` });
  const list = JSON.stringify(names);
  s.shots.forEach((shot, i) => {
    for (const who of shot.onScreen) {
      if (!names.includes(who)) {
        out.push({ path: ["shots", i, "onScreen"], message: `shot ${shot.id}: onScreen "${who}" is not one of the characters ${list}` });
      }
    }
    if (shot.line.trim() === "") return;
    const who = shot.speaker?.trim() ?? "";
    if (who === "") {
      out.push({ path: ["shots", i, "speaker"], message: `shot ${shot.id} has a spoken line but no speaker; set speaker to one of ${list}` });
    } else if (!names.includes(shot.speaker!)) {
      out.push({ path: ["shots", i, "speaker"], message: `shot ${shot.id}: speaker "${shot.speaker}" is not one of the characters ${list}` });
    } else if (!shot.onScreen.includes(shot.speaker!)) {
      out.push({
        path: ["shots", i, "onScreen"],
        message: `shot ${shot.id}: speaker "${shot.speaker}" must be in onScreen ${JSON.stringify(shot.onScreen)}`,
      });
    }
  });
  return out;
}

const RefinedScript = ScriptFields
  .superRefine((s, ctx) => {
    for (const p of castProblems(s)) ctx.addIssue({ code: "custom", path: p.path, message: p.message });
    const n = s.shots.length;
    if (n < 1 || n > MAX_SHOTS) {
      ctx.addIssue({ code: "custom", path: ["shots"], message: `a script has 1–${MAX_SHOTS} shots, got ${n}` });
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

/** Parses current scripts and migrates pre-F11 single-`character` ones (manifests on disk stay readable). */
export const Script = z.preprocess((raw) => migrateBlocking(migrateScript(raw)), RefinedScript);
export type Script = z.output<typeof RefinedScript>;

/** The character who says a shot's line (a silent shot: the first one on screen). */
export function speakerOf(script: Script, shot: Shot): Character {
  const name = shot.line.trim() !== "" && shot.speaker ? shot.speaker : shot.onScreen[0];
  const c = script.characters.find((x) => x.name === name) ?? script.characters[0];
  if (!c) throw new Error("script has no characters");
  return c;
}

/** Everyone visible in a shot, speaker first: reference images are uploaded, and numbered, in this order. */
export function castOf(script: Script, shot: Shot): Character[] {
  const first = speakerOf(script, shot);
  const rest = shot.onScreen
    .filter((x) => x !== first.name)
    .map((x) => script.characters.find((c) => c.name === x))
    .filter((c): c is Character => c !== undefined);
  return [first, ...rest];
}

/**
 * Who the keyframe (the first frame) shows: for a shot with cuts, the opening cut's cast only, speaker first when
 * they are in it. Characters seen only in later cuts are not in the keyframe; the video call still gets them.
 */
export function openingCastOf(script: Script, shot: Shot): Character[] {
  const opening = shot.cuts?.[0];
  if (!opening) return castOf(script, shot);
  const cast = castOf(script, shot).filter((c) => opening.onScreen.includes(c.name));
  // cutProblems rejects this at the boundary; a hand-built Shot must not slip through to an empty keyframe cast.
  if (cast.length === 0) throw new Error(`shot ${shot.id}: the first cut shows nobody, so the keyframe has no cast`);
  return cast;
}

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
  shotId: ShotId.optional(),
  n: z.number().int().min(1),
  provider: nonEmpty("provider"),
  ok: z.boolean(),
  /** Why it failed or why a retry/fallback happened. No silent fallbacks. */
  reason: z.string().optional(),
  costUsd: z.number().min(0),
  ms: z.number().min(0),
  /** Quality judge score (1–10) on stage "judge" attempts (F07). */
  score: z.number().int().min(1).max(10).optional(),
  /**
   * F19: paid in an earlier pass of this run (before a `--redo`) and copied into this manifest so `costUsd` stays the
   * true total. A redo that reuses the artifact records its own $0 attempt beside it.
   */
  carried: z.boolean().optional(),
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

/**
 * What the continuity critic returns (F18). `ok` with problems listed is treated as an objection: code trusts the
 * list, not the flag (a model that says ok and names a problem has found one).
 */
export const ContinuityVerdict = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()),
});
export type ContinuityVerdict = z.infer<typeof ContinuityVerdict>;

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
  /**
   * native = the video model spoke; fallback = verified TTS + lip-sync; voiceover = verified TTS laid over a wide
   * shot without lip-sync (F12: the face is too small to lip-read); silent = no line in this shot.
   */
  audio: z.enum(["native", "fallback", "voiceover", "silent"]),
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

/** One burned-in subtitle (F13): text of the verified line, seconds on the final timeline. */
export const SubtitleCue = z
  .object({ start: z.number().min(0), end: z.number().min(0), text: nonEmpty("cue text") })
  .refine((c) => c.end > c.start, { message: "cue end must be after its start", path: ["end"] });
export type SubtitleCue = z.infer<typeof SubtitleCue>;

export const Subtitles = z.object({
  /** The video file the cues were burned into. */
  file: nonEmpty("file"),
  cues: z.array(SubtitleCue).min(1),
  /** asr = timed by ASR word timestamps; spread = no timestamps, cues spread over the speech by word count. */
  timing: z.enum(["asr", "spread"]).optional(),
});
export type Subtitles = z.infer<typeof Subtitles>;

export const RunStatus = z.enum(["running", "done", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Redo = z.object({
  at: z.iso.datetime(),
  /** The graph step the run was replayed from. */
  from: nonEmpty("from"),
  /** New spend of that redo alone (cached artifacts cost $0). */
  costUsd: z.number().min(0),
});
export type Redo = z.infer<typeof Redo>;

export const RunManifest = z.object({
  runId: nonEmpty("runId"),
  idea: nonEmpty("idea"),
  mode: z.enum(["mock", "live"]),
  createdAt: z.iso.datetime(),
  script: Script.optional(),
  // partialRecord: zod 4's record over an enum demands every key, and a failed run may have only s1.
  shots: z.partialRecord(ShotId, ShotOutput).optional(),
  attempts: z.array(Attempt),
  costUsd: z.number().min(0),
  final: FinalVideo.optional(),
  verbatim: VerbatimResult.optional(),
  spoken: SpokenText.optional(),
  /** What was burned into the final file (F13); absent with --no-subtitles. */
  subtitles: Subtitles.optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** Non-fatal run-level notes (F16: a failed Langfuse export). They never change `ok`. */
  notes: z.array(z.string()).optional(),
  /**
   * F19: where the run is. `ok` is false until the final gate, so it can't tell "still going" from "failed".
   * Optional only for manifests written before F19 (the examples); every new manifest has it.
   */
  status: RunStatus.optional(),
  /** When this process started the run (a resume or redo restarts the clock). The web timer counts from it. */
  startedAt: z.iso.datetime().optional(),
  /** Set with `done`/`failed`; absent while running. */
  endedAt: z.iso.datetime().optional(),
  /** Every `--redo` of this run (F19): when, from which step, and what it spent itself. */
  redos: z.array(Redo).optional(),
});
export type RunManifest = z.infer<typeof RunManifest>;

/** One line per issue, "path: message" — short enough to feed back to a model as a retry reason. */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}
