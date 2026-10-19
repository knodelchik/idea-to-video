/**
 * Script-writer prompt. Bump SCRIPT_PROMPT_VERSION on any wording change: it is stored in every Script so runs
 * can be compared across prompt revisions.
 */
import { CAMERAS, MAX_SHOTS, SCRIPT_SECONDS, SHOT_SECONDS } from "../schemas.ts";
import { parseStoryboard, type Storyboard } from "../storyboard.ts";

// v2: shot range widened to the Seedance 2.0 clip range (F05), read from the schema so the two can't drift.
// v3: several quoted lines may share one shot line, in order (F10).
// v4: 1–2 characters, one speaker per spoken shot, a dialogue as shot-reverse-shot, voiceDescription (F11).
// v5: shot sizes from wide to close-up instead of close framing only, up to 4 shots, storyboard beats, looks that
//     read at a distance (F12).
export const SCRIPT_PROMPT_VERSION = "script-v5";

const sizes = CAMERAS.map((c) => `"${c}"`).join(", ");

export const SCRIPT_SYSTEM = `You write a single beat of a vertical (9:16) micro-drama: 8–30 seconds, 1 to ${MAX_SHOTS} shots (usually 2).

Craft:
- Hook in the first two seconds: open on the moment of tension, not on setup.
- One clear emotion. One character, or two when the idea has two people talk to each other.
- The line must sound spoken: short, plain words, contractions, no stage directions inside it.
- Each character's look: at least 12 words of concrete, renderable detail (age, face, hair, wardrobe), including 2–3
  high-contrast features that read at a distance (hair colour, one bright outfit colour, a silhouette item such as a
  long cloak or a wide hat). Repeat the look identically; never change these features between shots. Names are unique.
- Each character's voiceDescription: one sentence with timbre, gender, age, accent and pace, e.g.
  "warm low female voice, mid-30s, neutral American accent, unhurried".
- Write "visual", "motion", "emotion" and "setting" in English, whatever language the idea is in.

Shot sizes ("camera"), one of: ${sizes}.
- Pick each shot's size for what it must show. When the place matters (a castle, a ballroom, a street, a landscape),
  default to a "wide shot" or "full shot" to set the place, then a "medium close-up" for the key line.
- Never two close-ups in a row, unless it is a dialogue (shot-reverse-shot).
- A wide size ("extreme wide shot", "wide shot", "full shot") only when the place matters, composed vertically: tall
  architecture, stairs, towers or cliffs, the character small in the lower third.
- One camera move per shot in "motion" (wide: locked-off, or a slow crane / pull-back; close: a slow push-in).
- A spoken line may sit on any size. On a wide size the line is heard, not lip-read (the character is small). When
  you have the choice, put the key line on a "medium close-up".

Characters and speakers:
- "characters" has 1 or 2 entries. Every shot lists in "onScreen" the names of the characters visible in it.
- Every shot with a line has exactly one "speaker": the name of the character who says it, who is in "onScreen".
  A silent shot has no speaker.
- A dialogue between two people is shot-reverse-shot, one line per shot, each framed on whoever speaks.
- When the idea says who says a line ("she says…", "he answers…"), that person is the speaker of that line. Never give
  both people's lines to one character.

The spoken line:
- If the idea contains quoted text, that text IS the line, character-for-character: same words, case, punctuation.
  Do not shorten, fix, or "improve" it. Put each quoted line in a shot's "line" exactly as given.
  With more quoted lines than shots, one shot's "line" holds several of them in the idea's order, joined by a
  space, with no other words added.
- Otherwise write one short line, 16 words or fewer, with numbers spelled out as words (no digits), on the shot it
  fits best. Lines are always English.
- A shot without speech has "line": "".

Storyboards:
- When the idea is written shot by shot, the user message lists the beats. Write exactly one shot per beat, in that
  order (beat 1 is "s1"). A line quoted in beat k goes in shot k's line.

Timing:
- Shot ids are "s1", "s2", … in order. Each shot is ${SHOT_SECONDS.min}–${SHOT_SECONDS.max} seconds; the total is ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} seconds.
- A spoken shot needs at least (words / 2.6 + 0.8) seconds.

Return only JSON matching the schema.`;

/** The idea's storyboard, or null (also null for an idea parseStoryboard rejects: that idea never reaches the model). */
export function storyboardOf(idea: string): Storyboard | null {
  try {
    return parseStoryboard(idea);
  } catch {
    return null;
  }
}

function beatsBlock(board: Storyboard): string {
  const context = board.context ? `Shared context for every shot: ${board.context}\n` : "";
  return `The idea is a storyboard of ${board.beats.length} beats. Write exactly ${board.beats.length} shots, one per beat, in this order:\n${context}${board.beats.map((b, i) => `Beat ${i + 1} (shot s${i + 1}): ${b}`).join("\n")}`;
}

export function firstPrompt(idea: string, quoted: string[], board: Storyboard | null = storyboardOf(idea)): string {
  const q =
    quoted.length === 0
      ? "The idea quotes no line: write one."
      : `The idea quotes these lines. Use each one verbatim as a shot line:\n${quoted.map((l) => `- ${JSON.stringify(l)}`).join("\n")}`;
  return `Idea:\n${idea}\n\n${board ? `${beatsBlock(board)}\n\n` : ""}${q}`;
}

export function retryPrompt(idea: string, quoted: string[], previous: unknown, problems: string[]): string {
  return `${firstPrompt(idea, quoted)}

Your previous answer:
${JSON.stringify(previous, null, 2)}

It was rejected for these problems:
${problems.map((p) => `- ${p}`).join("\n")}

Return the full corrected script.`;
}
