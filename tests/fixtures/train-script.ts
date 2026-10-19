/**
 * A staged script for the F18 prompt and rubric tests: the live train run (2026-10-19) with the blocking it should
 * have had. s1 she runs away from the camera toward the carriage door; s2 the conductor's line, seen over her
 * shoulder, then a reaction cut to her after the line.
 */
import { Script } from "../../src/schemas.ts";

export const TRAIN_LINE = "Ticket, please. This train doesn't wait.";
export const DOOR = "the open door of the last carriage";

export const TRAIN_SCRIPT = Script.parse({
  promptVersion: "script-v8",
  title: "The Last Train",
  logline: "A woman runs for the last train; the conductor will not let her on.",
  setting: "a rain-soaked train platform at night under an old station clock",
  characters: [
    {
      name: "Olena",
      look: "a young woman in her twenties with short silver hair, a bright yellow raincoat and black rubber boots",
      voice: { gender: "female", age: "young", tone: "breathless" },
      voiceDescription: "breathless young female voice, mid-20s, light Ukrainian accent, quick",
    },
    {
      name: "Conductor",
      look: "a tired man in his sixties with a grey moustache, a navy conductor's uniform and a peaked cap",
      voice: { gender: "male", age: "older", tone: "gruff" },
      voiceDescription: "gruff low male voice, sixties, neutral accent, slow",
    },
  ],
  shots: [
    {
      id: "s1",
      camera: "wide shot",
      visual: "Olena runs from the foreground toward the open carriage door in the background, right",
      motion: "locked-off camera",
      emotion: "desperate hope",
      line: "",
      seconds: 4,
      onScreen: ["Olena"],
      blocking: {
        subjects: [{ name: "Olena", position: "foreground", side: "left", facing: "away" }],
        movement: { who: "Olena", direction: "away from camera", target: DOOR, targetPosition: { position: "background", side: "right" }, pace: "real-time" },
        speaking: null,
      },
      continuity: { from: "start", screenDirection: "left to right" },
    },
    {
      id: "s2",
      camera: "medium shot",
      visual: "the conductor blocks the carriage door, Olena seen from behind",
      motion: "slow push-in",
      emotion: "weary refusal",
      line: TRAIN_LINE,
      seconds: 8,
      speaker: "Conductor",
      onScreen: ["Conductor", "Olena"],
      cuts: [
        {
          camera: "medium shot",
          visual: "the conductor in the doorway, Olena's back in the foreground",
          onScreen: ["Conductor", "Olena"],
          blocking: {
            subjects: [
              { name: "Conductor", position: "midground", side: "center", facing: "camera" },
              { name: "Olena", position: "foreground", side: "left", facing: "away" },
            ],
            movement: null,
            speaking: "Conductor",
          },
        },
        {
          camera: "close-up",
          visual: "Olena's face after the line, rain on her cheeks",
          onScreen: ["Olena"],
          blocking: { subjects: [{ name: "Olena", position: "midground", side: "center", facing: "camera" }], movement: null, speaking: null },
        },
      ],
      blocking: {
        subjects: [
          { name: "Conductor", position: "midground", side: "center", facing: "camera" },
          { name: "Olena", position: "foreground", side: "left", facing: "away" },
        ],
        movement: null,
        speaking: "Conductor",
      },
      continuity: { from: "she reached the carriage door at the end of s1; now the conductor blocks it", screenDirection: "left to right" },
    },
  ],
  quotedLines: [TRAIN_LINE],
});
