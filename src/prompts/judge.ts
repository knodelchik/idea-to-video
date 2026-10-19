/**
 * Judge rubrics (F07). Pure, so tests can pin what the judge is asked. They name only what a VLM can see; durations,
 * words and formats are checked by code. Bump JUDGE_PROMPT_VERSION on any wording change: it is part of the key of
 * every cached verdict.
 */
import { isWide, openingCastOf, openingOf, speakerOf, type Blocking, type Script, type Shot } from "../schemas.ts";
import { FACING, goalOf, movementPhrase, openingBlocking, slowMotionIn, speakingSentence, where } from "./staging.ts";

// v2: references are the on-screen characters' portraits; the clip is judged against the speaker's portrait (F11).
// v3: wide sizes are judged on recognisability, whole figures and a dominant setting, not on lip-sync (F12).
// v4: a clip with cuts (F13) is told its hard cuts are intended, so a change of framing is not a failure.
// v5: a cut shot's keyframe is judged against the opening cut's cast only (F13, human note).
// v6: a planned camera move may take the character out of frame; the action must match the shot (live 2026-10-19).
// v7: the clip judge watches the clip itself (video + audio) instead of 3 frames; it must not score the words (F14).
// v8: blocking (F18): the keyframe is checked for positions and a visible goal; the clip for movement direction,
//     real-time pace and who moves their lips; a cut clip lists who is in each cut (a planned reaction cut scored 1/10
//     as "identity changed", live 2026-10-19).
export const JUDGE_PROMPT_VERSION = "judge-v8";

/** The judge may hear the clip, but whether the words are right is the verbatim gate's job (ASR + WER), not a VLM's. */
const AUDIO_NOTE =
  "You may hear the audio, but speech is checked elsewhere: do not score the words, the voice or the lip-sync timing against the script.";

/**
 * Said to the clip judge when the shot has cuts: the framing changes on purpose; only identity must hold. Each cut
 * lists who is in it (F18), so a planned reaction cut to another person is not read as "the identity changed".
 */
function cutsNote(shot: Shot): string[] {
  if (!shot.cuts?.length) return [];
  const sizes = shot.cuts
    .map((c, i) => `${i + 1}) ${oneLine(c.camera)}: ${c.onScreen.length ? c.onScreen.map(oneLine).join(" and ") : "no people (an insert)"}`)
    .join(", ");
  return [
    `Note: this clip has ${shot.cuts.length} intended hard cuts (${sizes}); a change of framing, angle or person between cuts as listed is not a failure, and a character only has to match where they are shown.`,
  ];
}

/** Who stands where in a blocking, for the judge: "Olena in the foreground left, facing away". */
const placed = (b: Blocking): string => b.subjects.map((s) => `${oneLine(s.name)} in ${where(s)}, ${FACING[s.facing]}`).join("; ");

/** Keyframe staging item (F18): positions roughly as blocked, and the movement's goal already in frame. */
function keyframeStaging(shot: Shot, n: number): string[] {
  const b = openingBlocking(shot);
  if (b.subjects.length === 0) return [];
  const goal = goalOf(b.movement);
  return [`${n}. Staging, roughly: ${placed(b)}.${goal ? ` The goal of the movement, ${goal}, is visible.` : ""}`];
}

/** Clip staging items (F18): direction and goal of each movement, pace, and who moves their lips (per cut). */
function clipStaging(shot: Shot, script: Script, n: number): string[] {
  const frames = shot.cuts?.length ? shot.cuts.map((c, i) => ({ at: `Cut ${i + 1}: `, b: c.blocking })) : [{ at: "", b: shot.blocking }];
  const moves = frames
    .filter((f) => f.b.movement && f.b.movement.direction !== "none")
    .map((f) => `${f.at}${oneLine(f.b.movement!.who)} ${movementPhrase(f.b.movement!)}`);
  const lips = frames.filter((f) => f.b.subjects.length > 0).map((f) => `${f.at}${speakingSentence(f.b, script)}`);
  return [
    moves.length
      ? `${n}. Direction: ${moves.join("; ")}. The target must be visible; moving the other way (toward instead of away, or the reverse) is a failure.`
      : `${n}. Direction: nobody is staged to travel; a character who walks or runs somewhere the shot does not ask for is a failure.`,
    slowMotionIn(shot)
      ? `${n + 1}. Pace: slow motion only where the staging asks for it.`
      : `${n + 1}. Pace: real time, natural speed; any slow motion is a failure.`,
    `${n + 2}. Lips: ${lips.join(" ")} A silent character whose lips move as if speaking is a failure.`,
  ];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A keyframe: the first frame a video model animates and a lip-sync model works on. Refs: on-screen portraits. */
export function keyframeRubric(shot: Shot, script: Script): string {
  // With cuts (F13) the keyframe is the opening cut: its cast and size only.
  const cast = openingCastOf(script, shot);
  const wide = isWide(openingOf(shot).camera);
  const who =
    cast.length === 1
      ? `4. It matches the character: ${oneLine(cast[0]!.look)}; the same person as the reference portrait.`
      : `4. It shows ${cast.length} people, each the same person as their reference portrait, in order: ${cast.map((c) => `${oneLine(c.name)} (${oneLine(c.look)})`).join("; ")}. Nobody appears twice.`;
  return [
    wide
      ? "Judge this keyframe for a vertical 9:16 wide shot, the character small in a large setting. Check, and list every failure as an issue:"
      : "Judge this keyframe for a vertical 9:16 talking-head video. Check, and list every failure as an issue:",
    "1. Anatomy: correct hands and fingers, eyes, teeth, limbs; nothing melted, duplicated or missing.",
    wide
      ? "2. The character is recognisable by its look (hair, outfit, silhouette), anatomically whole (full figure, not cropped or merged with the background), and the setting matches and dominates the frame."
      : "2. The face is large and sharp enough for lip-sync: frontal or three-quarter, mouth fully visible, in focus.",
    `3. It matches the shot: ${oneLine(openingOf(shot).camera)}. ${oneLine(openingOf(shot).visual)}. Setting: ${oneLine(script.setting)}.`,
    who,
    "5. No text, captions, logos or watermark anywhere.",
    wide
      ? "6. Vertical composition: the place fills a portrait frame (tall architecture or landscape), the character small, nothing important cut off."
      : "6. Vertical composition: the subject fills a portrait frame, nothing important cut off.",
    ...keyframeStaging(shot, 7),
  ].join("\n");
}

/**
 * A clip, with the speaker's portrait (silent shot: first on screen) as reference. `video`: the judge watches the clip
 * itself (F14, what the pipeline sends); otherwise it sees a few evenly sampled frames (the bench).
 */
export function clipRubric(shot: Shot, script: Script, opts: { video?: boolean } = {}): string {
  const speaking = shot.line.trim() !== "";
  const c = speakerOf(script, shot);
  const video = opts.video === true;
  const audio = video ? [AUDIO_NOTE] : [];
  if (isWide(shot.camera)) {
    // The face is too small to judge a mouth; at a distance the failures are extra or melting figures and wobbling buildings.
    return [
      video
        ? "Watch this vertical video clip, a wide shot with the character small in frame. Check, and list every failure as an issue:"
        : "Judge these frames, sampled in order from one vertical wide-shot video clip, the character small in frame. Check, and list every failure as an issue:",
      `1. The ${speaking ? "speaker" : "main character"}, ${oneLine(c.name)}, is recognisable by its look (hair, outfit, silhouette: ${oneLine(c.look)}) whenever in view. Leaving the frame because of the planned camera move is fine, not a failure; a figure that vanishes or changes while the camera keeps the spot in view is.`,
      "2. No duplicated, merging or melting figures: the same number of people in every frame, each anatomically whole.",
      "3. Stable architecture and setting: walls, doors, stairs and horizon keep their shape between frames, no warping.",
      `4. Motion plausible for: ${oneLine(shot.motion)}.`,
      `5. The action matches the shot: ${oneLine(shot.visual)}. Check the direction of movement (toward or away from what), who does what, and where they go; say exactly what differs.`,
      ...clipStaging(shot, script, 6),
      ...cutsNote(shot),
      ...audio,
    ].join("\n");
  }
  return [
    video
      ? "Watch this vertical video clip. Check, and list every failure as an issue:"
      : "Judge these frames, sampled in order from one vertical video clip. Check, and list every failure as an issue:",
    `1. The ${speaking ? "speaker" : "main character"}, ${oneLine(c.name)}, is the same person as the reference portrait in every frame (${oneLine(c.look)}).`,
    "2. No warping or morphing: face, hands and background stay stable and coherent between frames.",
    speaking
      ? "3. Mouth region intact and natural in every frame (it is speaking): no smearing, extra teeth or blur."
      : "3. Mouth region intact and natural in every frame; the character is silent.",
    `4. Motion plausible for: ${oneLine(shot.motion)}.`,
    `5. The action matches the shot: ${oneLine(shot.visual)}. Check the direction of movement, who does what, and where they go; say exactly what differs.`,
    ...clipStaging(shot, script, 6),
    ...cutsNote(shot),
    ...audio,
  ].join("\n");
}

/** The retry prompt: the original, plus what the judge saw wrong, so the next take can fix it. */
export function withIssues(prompt: string, issues: string[]): string {
  const note = issuesNote(issues);
  return note ? `${prompt} ${note}` : prompt;
}

/** The judge's issues as one sentence ("" when there are none), for prompts that place it themselves. */
export function issuesNote(issues: string[]): string {
  const list = issues.map(oneLine).filter(Boolean);
  return list.length ? `Avoid these problems from the previous attempt: ${list.join("; ")}.` : "";
}
