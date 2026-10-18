/**
 * Image and video prompts. Pure, so tests can pin exactly what a model is asked for. Bump VISUALS_PROMPT_VERSION
 * on any wording change: it is part of every artifact's content key, so a changed prompt makes a new file.
 */
import type { Script, Shot } from "../schemas.ts";
import { splitDelivery } from "../verbatim.ts";

export const VISUALS_PROMPT_VERSION = "visuals-v2";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Image and video models write gibberish: any note, sign or screen in frame must show no readable writing. */
const NO_WRITING = "Any paper, note, sign or screen in frame shows no legible writing: blank, folded, or turned away from the camera.";

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
    NO_WRITING,
  ].join(" ");
}

/**
 * Image-to-video prompt. The spoken line goes in double quotes exactly as written (Seedance lip-syncs quoted
 * dialogue); delivery tags ("[whispers]") are not words, so they move into the emotion instead of the quote.
 */
export function talkingPrompt(shot: Shot, script: Script): string {
  const { spoken, tags, emoji } = splitDelivery(shot.line);
  const emotion = [oneLine(shot.emotion), ...tags].filter(Boolean).join(", ");
  const scene = `${oneLine(shot.visual)}. ${oneLine(shot.motion)}.`;
  if (spoken === "") {
    return [
      scene,
      `Emotion: ${emotion}. One person, ${oneLine(script.character.name)}, silent, mouth closed.`,
      "Locked-off camera with at most a slow push-in. No speech, no music, no text.",
      NO_WRITING,
    ].join(" ");
  }
  // Emoji are not words either: a model asked to "say" 🚀 may improvise one (F10).
  const said = tags.length || emoji ? spoken : shot.line;
  return [
    scene,
    `${oneLine(script.character.name)} looks toward the camera and says, ${emotion}: "${said}"`,
    "Exactly these words, once, in English, clearly lip-synced.",
    "One speaking face toward the camera; locked-off camera with at most a slow push-in.",
    "No other speech, no music, no subtitles, no text.",
    NO_WRITING,
  ].join(" ");
}

/**
 * Prompt without a first frame, for when the provider refuses the keyframe (real-face filter). With `refs`, the
 * images are references: the first is the portrait (identity), the last the keyframe (scene and framing). Without
 * them the model only knows what the text says, so the look and the setting lead either way.
 */
export function textToVideoPrompt(shot: Shot, script: Script, opts: { refs?: number } = {}): string {
  const c = script.character;
  const refs = opts.refs ?? 0;
  const refLine =
    refs >= 2
      ? `Reference image 1 is ${oneLine(c.name)}: keep exactly this face, hair and outfit. Reference image ${refs} shows the scene and framing to match.`
      : refs === 1
        ? `The reference image shows ${oneLine(c.name)} in the scene: keep exactly this face, hair, outfit and framing.`
        : "";
  return [
    `Photoreal vertical 9:16 ${shot.camera} of ${oneLine(c.name)}, ${oneLine(c.look)}.`,
    `Setting: ${oneLine(script.setting)}.`,
    refLine,
    talkingPrompt(shot, script),
  ]
    .filter(Boolean)
    .join(" ");
}
