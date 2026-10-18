/**
 * Script-writer prompt. Bump SCRIPT_PROMPT_VERSION on any wording change: it is stored in every Script so runs
 * can be compared across prompt revisions.
 */
import { SCRIPT_SECONDS, SHOT_SECONDS } from "../schemas.ts";

// v2: shot range widened to the Seedance 2.0 clip range (F05), read from the schema so the two can't drift.
// v3: several quoted lines may share one shot line, in order (F10).
// v4: 1–2 characters, one speaker per spoken shot, a dialogue as shot-reverse-shot, voiceDescription (F11).
export const SCRIPT_PROMPT_VERSION = "script-v4";

export const SCRIPT_SYSTEM = `You write a single beat of a vertical (9:16) micro-drama: 8–30 seconds, 1 or 2 shots.

Craft:
- Hook in the first two seconds: open on the moment of tension, not on setup.
- One location, one clear emotion. One character, or two when the idea has two people talk to each other.
- Close framing ("close-up" or "medium close-up") that keeps the face large; lip-sync depends on it.
- The line must sound spoken: short, plain words, contractions, no stage directions inside it.
- Each character's look: at least 12 words of concrete, renderable detail (age, face, hair, wardrobe, one distinctive
  mark), identical across shots. Names are unique.
- Each character's voiceDescription: one sentence with timbre, gender, age, accent and pace, e.g.
  "warm low female voice, mid-30s, neutral American accent, unhurried".

Characters and speakers:
- "characters" has 1 or 2 entries. Every shot lists in "onScreen" the names of the characters visible in it.
- Every shot with a line has exactly one "speaker": the name of the character who says it, who is in "onScreen".
  A silent shot has no speaker.
- A dialogue between two people is two shots (shot-reverse-shot), one line each, each a close-up of whoever speaks.
- When the idea says who says a line ("she says…", "he answers…"), that person is the speaker of that line. Never give
  both people's lines to one character.

The spoken line:
- If the idea contains quoted text, that text IS the line, character-for-character: same words, case, punctuation.
  Do not shorten, fix, or "improve" it. Put each quoted line in a shot's "line" exactly as given.
  With more quoted lines than shots, one shot's "line" holds several of them in the idea's order, joined by a
  space, with no other words added.
- Otherwise write one short line, 16 words or fewer, with numbers spelled out as words (no digits).
- A shot without speech has "line": "".

Timing:
- Shot ids are "s1" then "s2". Each shot is ${SHOT_SECONDS.min}–${SHOT_SECONDS.max} seconds; the total is ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} seconds.
- A spoken shot needs at least (words / 2.6 + 0.8) seconds.

Return only JSON matching the schema.`;

export function firstPrompt(idea: string, quoted: string[]): string {
  const q =
    quoted.length === 0
      ? "The idea quotes no line: write one."
      : `The idea quotes these lines. Use each one verbatim as a shot line:\n${quoted.map((l) => `- ${JSON.stringify(l)}`).join("\n")}`;
  return `Idea:\n${idea}\n\n${q}`;
}

export function retryPrompt(idea: string, quoted: string[], previous: unknown, problems: string[]): string {
  return `${firstPrompt(idea, quoted)}

Your previous answer:
${JSON.stringify(previous, null, 2)}

It was rejected for these problems:
${problems.map((p) => `- ${p}`).join("\n")}

Return the full corrected script.`;
}
