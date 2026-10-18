/**
 * Script stage. The model writes; code checks everything checkable and sends concrete notes back on failure.
 * Ideas that no script could satisfy (F10) are rejected before the first model call, so they cost nothing.
 */
import { performance } from "node:perf_hooks";
import type { LlmProvider } from "../providers/index.ts";
import { firstPrompt, retryPrompt, SCRIPT_PROMPT_VERSION, SCRIPT_SYSTEM } from "../prompts/script.ts";
import { castProblems, formatIssues, Script, SCRIPT_SECONDS, ScriptDraft, SHOT_SECONDS, type Attempt, type Character } from "../schemas.ts";
import { differentSpeakers, quoteSpeakers, speakerRuns } from "../speakers.ts";
import { extractQuotedLines, nonLatinLetters, QuoteError, splitDelivery, wordCount } from "../verbatim.ts";

/** Conservative speaking rate (words/s) plus breath, so TTS/video lines fit their shot. */
export const WORDS_PER_SECOND = 2.6;
export const LINE_PAD_SECONDS = 0.8;
export const MIN_LOOK_WORDS = 12;
/** The script has at most this many shots (Shot id enum: s1, s2). */
export const MAX_SHOTS = 2;

export const ENGLISH_ONLY =
  "only English lines are supported in this PoC (no video model officially supports Ukrainian speech yet); write the line in English";

const looseWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Seconds a shot needs to say `words` spoken words (one breath pad per shot). */
export const speakSeconds = (words: number): number => words / WORDS_PER_SECOND + LINE_PAD_SECONDS;

const spokenWords = (line: string) => wordCount(splitDelivery(line).spoken);

/**
 * Checks that need only the idea, run before any model call. Each one describes an idea no script can satisfy,
 * so asking the model would only spend money (and three retries) on a certain failure.
 */
export function preSpendProblems(idea: string): string[] {
  let quoted: string[];
  try {
    quoted = extractQuotedLines(idea);
  } catch (e) {
    if (e instanceof QuoteError) return [e.message];
    throw e;
  }
  const out: string[] = [];
  if (quoted.some((q) => nonLatinLetters(splitDelivery(q).spoken).length > 0)) out.push(ENGLISH_ONLY);

  const words = quoted.map(spokenWords);
  quoted.forEach((q, i) => {
    const need = speakSeconds(words[i]!);
    if (need > SHOT_SECONDS.max) {
      out.push(
        `quoted line ${JSON.stringify(q)}: ${words[i]} words need ${need.toFixed(1)} s to speak (words / ${WORDS_PER_SECOND} + ${LINE_PAD_SECONDS}) but one shot holds at most ${SHOT_SECONDS.max} s; shorten it`,
      );
    }
  });
  // Several quotes may share a shot (in order). Only fail when no split into ≤ MAX_SHOTS shots fits.
  if (out.length === 0 && quoted.length > 1 && !fitsShots(words)) {
    out.push(
      `${quoted.length} quoted lines (${words.reduce((a, b) => a + b, 0)} words) can't be spoken in order within ${MAX_SHOTS} shots of at most ${SHOT_SECONDS.max} s each; use fewer or shorter lines`,
    );
  }
  // One speaker per shot (F11): every change of speaker needs a new shot.
  const runs = speakerRuns(quoteSpeakers(idea));
  if (runs > MAX_SHOTS) {
    out.push(`the quoted lines change speaker ${runs - 1} times, but each of the ${MAX_SHOTS} shots has one speaker; use at most ${MAX_SHOTS} turns of dialogue`);
  }
  return out;
}

/** Can the quotes, in order, be split into ≤ 2 contiguous groups that each fit one shot? */
function fitsShots(words: number[]): boolean {
  const fits = (ws: number[]) => ws.length === 0 || speakSeconds(ws.reduce((a, b) => a + b, 0)) <= SHOT_SECONDS.max;
  for (let k = 1; k <= words.length; k++) if (fits(words.slice(0, k)) && fits(words.slice(k))) return true;
  return false;
}

/**
 * Place each quote, in idea order, as a contiguous part of one shot line. Returns, per shot, the line with its
 * quotes cut out (what the model added around them), and a problem for every quote that can't be placed.
 */
function placeQuotes(
  lines: string[],
  quoted: string[],
): { leftovers: (string | undefined)[]; problems: string[]; shotOf: number[] } {
  const leftovers: (string | undefined)[] = lines.map(() => undefined);
  const problems: string[] = [];
  /** Index of the shot each quote landed in; -1 when it is missing. */
  const shotOf: number[] = [];
  let shot = 0;
  let pos = 0;
  for (const q of quoted) {
    let s = shot;
    let at = -1;
    for (let from = pos; s < lines.length; s++, from = 0) {
      at = lines[s]!.indexOf(q, from);
      if (at >= 0) break;
    }
    if (at < 0) {
      const spoken = lines.filter((l) => l.trim() !== "").map((l) => JSON.stringify(l)).join(", ") || "none";
      problems.push(
        `quoted line ${JSON.stringify(q)} must appear in a shot line exactly, character-for-character, after the quoted lines before it; shot lines were: ${spoken}`,
      );
      shotOf.push(-1);
      continue;
    }
    const left = leftovers[s] ?? lines[s]!;
    // Cut by blanking the same span length, so later positions in this line stay valid.
    leftovers[s] = left.slice(0, at) + " ".repeat(q.length) + left.slice(at + q.length);
    shot = s;
    pos = at + q.length;
    shotOf.push(s);
  }
  return { leftovers, problems, shotOf };
}

/** Deterministic checks. Each message names the field and the fix, since it goes straight back to the model. */
export function scriptProblems(script: Script, idea: string): string[] {
  const out: string[] = [];
  const quoted = extractQuotedLines(idea);
  const lines = script.shots.map((s) => s.line);

  const { leftovers, problems, shotOf } = placeQuotes(lines, quoted);
  out.push(...problems);
  out.push(...castProblems(script).map((p) => p.message));
  out.push(...speakerProblems(script, idea, quoted, shotOf));
  if (JSON.stringify(script.quotedLines) !== JSON.stringify(quoted)) {
    out.push(`quotedLines must be ${JSON.stringify(quoted)}, got ${JSON.stringify(script.quotedLines)}`);
  }

  const n = script.shots.length;
  if (n < 1 || n > MAX_SHOTS) out.push(`a script has 1–${MAX_SHOTS} shots, got ${n}`);
  script.shots.forEach((s, i) => {
    if (s.id !== `s${i + 1}`) out.push(`shot ${i + 1} must have id "s${i + 1}", got "${s.id}"`);
  });

  const total = script.shots.reduce((sum, s) => sum + s.seconds, 0);
  if (n > 0 && (total < SCRIPT_SECONDS.min || total > SCRIPT_SECONDS.max)) {
    out.push(`total duration ${total} s is outside ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} s`);
  }

  script.shots.forEach((s, i) => {
    const words = spokenWords(s.line);
    const need = speakSeconds(words);
    if (words > 0 && need > s.seconds) {
      out.push(
        `shot ${s.id}: ${words} words need ${need.toFixed(1)} s to speak (words / ${WORDS_PER_SECOND} + ${LINE_PAD_SECONDS}) but the shot has ${s.seconds} s; shorten the line or lengthen the shot`,
      );
    }
    const leftover = leftovers[i];
    if (leftover !== undefined) {
      // A line holding quotes is the user's words only: nothing may be added around them (tags/emoji aside).
      const extra = splitDelivery(leftover).spoken.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
      if (extra !== "") out.push(`shot ${s.id} line adds words outside the quoted lines: ${JSON.stringify(extra)}; a shot line holding quotes must contain only those quotes`);
    } else {
      // Quoted lines stay as written; everything the model wrote must be speakable as-is.
      const digits = s.line.match(/\p{Nd}+/gu);
      if (digits) out.push(`shot ${s.id} line has digits ${digits.map((d) => `"${d}"`).join(", ")}; spell numbers out as words`);
      if (nonLatinLetters(splitDelivery(s.line).spoken).length > 0) out.push(`shot ${s.id}: ${ENGLISH_ONLY}`);
    }
  });

  script.characters.forEach((c, i) => {
    const look = looseWords(c.look);
    if (look < MIN_LOOK_WORDS) {
      out.push(`characters[${i}].look (${c.name}) has ${look} words; needs at least ${MIN_LOOK_WORDS} words of concrete visual detail`);
    }
  });
  return out;
}

/**
 * Each quoted line is said by a plausible speaker (F11): lines the idea gives to different people go to different
 * characters, and a "she"/"he" line goes to a character with that voice. Catches the silent failure where one
 * character says both halves of a dialogue ("…, Mom." to herself).
 */
function speakerProblems(script: Script, idea: string, quoted: string[], shotOf: number[]): string[] {
  const said = quoteSpeakers(idea);
  const out: string[] = [];
  const speakerAt = (i: number): Character | undefined => {
    const shot = script.shots[shotOf[i] ?? -1];
    return shot?.speaker ? script.characters.find((c) => c.name === shot.speaker) : undefined;
  };
  const q = (i: number) => `${JSON.stringify(quoted[i])} (${said[i]!.who})`;
  let reportedCount = false;
  for (let i = 0; i < quoted.length; i++) {
    for (let j = i + 1; j < quoted.length; j++) {
      if (!differentSpeakers(said[i], said[j])) continue;
      if (script.characters.length < 2) {
        if (!reportedCount) {
          out.push(
            `the idea gives lines to two different people (${said[i]!.who} and ${said[j]!.who}) but the script has ${script.characters.length} character; add the second character and make each one the speaker of their own line`,
          );
          reportedCount = true;
        }
        continue;
      }
      const a = speakerAt(i);
      if (a && a === speakerAt(j)) {
        out.push(`quoted lines ${q(i)} and ${q(j)} are said by different people in the idea, but "${a.name}" says both; give each line to its own speaker`);
      }
    }
    const gender = said[i]?.gender;
    const who = speakerAt(i);
    if (gender && who && who.voice.gender !== gender) {
      out.push(`quoted line ${q(i)} is said by a ${gender} speaker in the idea, but its shot's speaker "${who.name}" has a ${who.voice.gender} voice`);
    }
  }
  return out;
}

/** Lines too long for the lip-sync fallback: allowed, but the manifest says so up front (F10). */
export function lipsyncNotes(script: Script, maxSeconds: number): string[] {
  if (!Number.isFinite(maxSeconds)) return [];
  return script.shots.flatMap((s) => {
    const words = spokenWords(s.line);
    const need = speakSeconds(words);
    return words > 0 && need > maxSeconds
      ? [`shot ${s.id}: line needs ${need.toFixed(1)} s, over the lip-sync max ${maxSeconds} s: no lip-sync fallback for this line`]
      : [];
  });
}

export class ScriptError extends Error {
  constructor(
    readonly problems: string[],
    readonly attempts: Attempt[],
  ) {
    super(`script rejected after ${attempts.length} attempts:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "ScriptError";
  }
}

/** The idea itself can't be made (preSpendProblems). Thrown before any model call; carries one $0 attempt. */
export class IdeaRejectedError extends Error {
  constructor(
    readonly problems: string[],
    readonly attempts: Attempt[],
  ) {
    super(`idea rejected before any paid call: ${problems.join("; ")}`);
    this.name = "IdeaRejectedError";
  }
}

export interface WriteScriptOpts {
  llm: LlmProvider;
  maxAttempts?: number;
  /** The lip-sync provider's input limit (s); longer lines are noted on the script attempt. Default: no limit. */
  lipsyncMaxSeconds?: number;
}

export async function writeScript(
  idea: string,
  { llm, maxAttempts = 3, lipsyncMaxSeconds = Infinity }: WriteScriptOpts,
): Promise<{ script: Script; attempts: Attempt[] }> {
  const rejected = preSpendProblems(idea);
  if (rejected.length) {
    const attempt: Attempt = { stage: "script", n: 1, provider: "pre-spend-check", ok: false, reason: rejected.join("; "), costUsd: 0, ms: 0 };
    throw new IdeaRejectedError(rejected, [attempt]);
  }
  const quoted = extractQuotedLines(idea);
  const attempts: Attempt[] = [];
  let problems: string[] = [];
  let previous: unknown;

  for (let n = 1; n <= maxAttempts; n++) {
    const prompt = n === 1 ? firstPrompt(idea, quoted) : retryPrompt(idea, quoted, previous, problems);
    const t0 = performance.now();
    const r = await llm.generateJson({ system: SCRIPT_SYSTEM, prompt, schema: ScriptDraft });
    const ms = Math.round(performance.now() - t0);
    previous = r.raw;

    let script: Script | undefined;
    if (r.ok) {
      script = { ...r.data, promptVersion: SCRIPT_PROMPT_VERSION, quotedLines: quoted };
      problems = scriptProblems(script, idea);
      if (problems.length === 0) {
        // Belt and braces: the contract must agree with the checks above.
        const parsed = Script.safeParse(script);
        if (!parsed.success) problems = formatIssues(parsed.error).split("\n");
        else script = parsed.data;
      }
    } else {
      problems = r.error.split("\n").filter(Boolean);
    }

    const ok = problems.length === 0;
    const notes = ok && script ? lipsyncNotes(script, lipsyncMaxSeconds) : [];
    const reason = [...(r.notes ?? []), ...problems, ...notes].join("; ");
    attempts.push({
      stage: "script",
      n,
      provider: r.model ? `${llm.name}:${r.model}` : llm.name,
      ok,
      ...(reason ? { reason } : {}),
      costUsd: r.costUsd,
      ms,
    });
    if (ok && script) return { script, attempts };
  }
  throw new ScriptError(problems, attempts);
}
