/**
 * Judge rubrics (F07). Pure, so tests can pin what the judge is asked. They name only what a VLM can see; durations,
 * words and formats are checked by code. Bump JUDGE_PROMPT_VERSION on any wording change: it is part of the key of
 * every cached verdict.
 */
import type { Script, Shot } from "../schemas.ts";

export const JUDGE_PROMPT_VERSION = "judge-v1";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A keyframe: the first frame a video model animates and a lip-sync model works on. */
export function keyframeRubric(shot: Shot, script: Script): string {
  const c = script.character;
  return [
    "Judge this keyframe for a vertical 9:16 talking-head video. Check, and list every failure as an issue:",
    "1. Anatomy: correct hands and fingers, eyes, teeth, limbs; nothing melted, duplicated or missing.",
    "2. The face is large and sharp enough for lip-sync: frontal or three-quarter, mouth fully visible, in focus.",
    `3. It matches the shot: ${oneLine(shot.camera)}. ${oneLine(shot.visual)}. Setting: ${oneLine(script.setting)}.`,
    `4. It matches the character: ${oneLine(c.look)}; the same person as the reference portrait.`,
    "5. No text, captions, logos or watermark anywhere.",
    "6. Vertical composition: the subject fills a portrait frame, nothing important cut off.",
  ].join("\n");
}

/** A clip, seen as a few evenly sampled frames, with the portrait as reference. */
export function clipRubric(shot: Shot, script: Script): string {
  const speaking = shot.line.trim() !== "";
  return [
    "Judge these frames, sampled in order from one vertical video clip. Check, and list every failure as an issue:",
    `1. Same person as the reference portrait in every frame (${oneLine(script.character.look)}).`,
    "2. No warping or morphing: face, hands and background stay stable and coherent between frames.",
    speaking
      ? "3. Mouth region intact and natural in every frame (it is speaking): no smearing, extra teeth or blur."
      : "3. Mouth region intact and natural in every frame; the character is silent.",
    `4. Motion plausible for: ${oneLine(shot.motion)}.`,
  ].join("\n");
}

/** The retry prompt: the original, plus what the judge saw wrong, so the next take can fix it. */
export function withIssues(prompt: string, issues: string[]): string {
  const list = issues.map(oneLine).filter(Boolean);
  if (list.length === 0) return prompt;
  return `${prompt} Avoid these problems from the previous attempt: ${list.join("; ")}.`;
}
