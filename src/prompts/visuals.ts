/**
 * Image and video prompts. Pure, so tests can pin exactly what a model is asked for. Bump VISUALS_PROMPT_VERSION
 * on any wording change: it is part of every artifact's content key, so a changed prompt makes a new file.
 */
import type { Script, Shot } from "../schemas.ts";
import { splitDelivery } from "../verbatim.ts";

export const VISUALS_PROMPT_VERSION = "visuals-v1";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Identity anchor: every keyframe is generated with this as a reference, so the face is decided once. */
export function portraitPrompt(script: Script): string {
  const c = script.character;
  return [
    `Character reference portrait of ${oneLine(c.name)}: ${oneLine(c.look)}.`,
    "Head and shoulders, facing the camera, face large in frame, neutral expression, mouth closed.",
    "Soft even neutral light, plain light-grey background.",
    "Photoreal, vertical 9:16, no text, no watermark.",
  ].join(" ");
}

/** First frame of a shot. Mouth closed: the video model opens it when the line starts. */
export function keyframePrompt(shot: Shot, script: Script): string {
  const c = script.character;
  return [
    `${oneLine(c.name)}, ${oneLine(c.look)}.`,
    `Setting: ${oneLine(script.setting)}.`,
    `Shot: ${shot.camera}. ${oneLine(shot.visual)}.`,
    `Emotion: ${oneLine(shot.emotion)}.`,
    "Same person as the reference image.",
    "Photoreal, cinematic, vertical 9:16, face clearly visible, mouth closed, no text, no watermark.",
  ].join(" ");
}

/**
 * Image-to-video prompt. The spoken line goes in double quotes exactly as written (Seedance lip-syncs quoted
 * dialogue); delivery tags ("[whispers]") are not words, so they move into the emotion instead of the quote.
 */
export function talkingPrompt(shot: Shot, script: Script): string {
  const { spoken, tags } = splitDelivery(shot.line);
  const emotion = [oneLine(shot.emotion), ...tags].filter(Boolean).join(", ");
  const scene = `${oneLine(shot.visual)}. ${oneLine(shot.motion)}.`;
  if (spoken === "") {
    return [
      scene,
      `Emotion: ${emotion}. One person, ${oneLine(script.character.name)}, silent, mouth closed.`,
      "Locked-off camera with at most a slow push-in. No speech, no music, no text.",
    ].join(" ");
  }
  const said = tags.length ? spoken : shot.line;
  return [
    scene,
    `${oneLine(script.character.name)} looks toward the camera and says, ${emotion}: "${said}"`,
    "Exactly these words, once, in English, clearly lip-synced.",
    "One speaking face toward the camera; locked-off camera with at most a slow push-in.",
    "No other speech, no music, no subtitles, no text.",
  ].join(" ");
}
