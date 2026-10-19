/**
 * Judge rubrics (F07). Pure, so tests can pin what the judge is asked. They name only what a VLM can see; durations,
 * words and formats are checked by code. Bump JUDGE_PROMPT_VERSION on any wording change: it is part of the key of
 * every cached verdict.
 */
import { castOf, isWide, speakerOf, type Script, type Shot } from "../schemas.ts";

// v2: references are the on-screen characters' portraits; the clip is judged against the speaker's portrait (F11).
// v3: wide sizes are judged on recognisability, whole figures and a dominant setting, not on lip-sync (F12).
export const JUDGE_PROMPT_VERSION = "judge-v3";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A keyframe: the first frame a video model animates and a lip-sync model works on. Refs: on-screen portraits. */
export function keyframeRubric(shot: Shot, script: Script): string {
  const cast = castOf(script, shot);
  const wide = isWide(shot.camera);
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
    `3. It matches the shot: ${oneLine(shot.camera)}. ${oneLine(shot.visual)}. Setting: ${oneLine(script.setting)}.`,
    who,
    "5. No text, captions, logos or watermark anywhere.",
    wide
      ? "6. Vertical composition: the place fills a portrait frame (tall architecture or landscape), the character small, nothing important cut off."
      : "6. Vertical composition: the subject fills a portrait frame, nothing important cut off.",
  ].join("\n");
}

/** A clip, seen as a few evenly sampled frames, with the speaker's portrait (silent shot: first on screen) as reference. */
export function clipRubric(shot: Shot, script: Script): string {
  const speaking = shot.line.trim() !== "";
  const c = speakerOf(script, shot);
  if (isWide(shot.camera)) {
    // The face is too small to judge a mouth; at a distance the failures are extra or melting figures and wobbling buildings.
    return [
      "Judge these frames, sampled in order from one vertical wide-shot video clip, the character small in frame. Check, and list every failure as an issue:",
      `1. The ${speaking ? "speaker" : "main character"}, ${oneLine(c.name)}, is recognisable in every frame by its look (hair, outfit, silhouette: ${oneLine(c.look)}).`,
      "2. No duplicated, merging or melting figures: the same number of people in every frame, each anatomically whole.",
      "3. Stable architecture and setting: walls, doors, stairs and horizon keep their shape between frames, no warping.",
      `4. Motion plausible for: ${oneLine(shot.motion)}.`,
    ].join("\n");
  }
  return [
    "Judge these frames, sampled in order from one vertical video clip. Check, and list every failure as an issue:",
    `1. The ${speaking ? "speaker" : "main character"}, ${oneLine(c.name)}, is the same person as the reference portrait in every frame (${oneLine(c.look)}).`,
    "2. No warping or morphing: face, hands and background stay stable and coherent between frames.",
    speaking
      ? "3. Mouth region intact and natural in every frame (it is speaking): no smearing, extra teeth or blur."
      : "3. Mouth region intact and natural in every frame; the character is silent.",
    `4. Motion plausible for: ${oneLine(shot.motion)}.`,
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
