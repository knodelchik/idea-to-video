/**
 * Script-writer prompt. Bump SCRIPT_PROMPT_VERSION on any wording change: it is stored in every Script so runs
 * can be compared across prompt revisions.
 */
export const SCRIPT_PROMPT_VERSION = "script-v1";

export const SCRIPT_SYSTEM = `You write a single beat of a vertical (9:16) micro-drama: 8–30 seconds, 1 or 2 shots.

Craft:
- Hook in the first two seconds: open on the moment of tension, not on setup.
- One character, one location, one clear emotion.
- Close framing ("close-up" or "medium close-up") that keeps the face large; lip-sync depends on it.
- The line must sound spoken: short, plain words, contractions, no stage directions inside it.
- character.look: at least 12 words of concrete, renderable detail (age, face, hair, wardrobe, one distinctive mark),
  identical across shots.

The spoken line:
- If the idea contains quoted text, that text IS the line, character-for-character: same words, case, punctuation.
  Do not shorten, fix, or "improve" it. Put each quoted line in a shot's "line" exactly as given.
- Otherwise write one short line, 16 words or fewer, with numbers spelled out as words (no digits).
- A shot without speech has "line": "".

Timing:
- Shot ids are "s1" then "s2". Each shot is 3–10 seconds; the total is 8–30 seconds.
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
