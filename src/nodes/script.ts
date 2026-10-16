/**
 * Script stage. The model writes; code checks everything checkable and sends concrete notes back on failure.
 */
import { performance } from "node:perf_hooks";
import type { LlmProvider } from "../providers/index.ts";
import { firstPrompt, retryPrompt, SCRIPT_PROMPT_VERSION, SCRIPT_SYSTEM } from "../prompts/script.ts";
import { formatIssues, Script, SCRIPT_SECONDS, ScriptDraft, type Attempt } from "../schemas.ts";
import { extractQuotedLines, wordCount } from "../verbatim.ts";

/** Conservative speaking rate (words/s) plus breath, so TTS/video lines fit their shot. */
export const WORDS_PER_SECOND = 2.6;
export const LINE_PAD_SECONDS = 0.8;
export const MIN_LOOK_WORDS = 12;

const looseWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Deterministic checks. Each message names the field and the fix, since it goes straight back to the model. */
export function scriptProblems(script: Script, idea: string): string[] {
  const out: string[] = [];
  const quoted = extractQuotedLines(idea);
  const lines = script.shots.map((s) => s.line);

  for (const q of quoted) {
    if (!lines.includes(q)) {
      const spoken = lines.filter((l) => l.trim() !== "").map((l) => JSON.stringify(l)).join(", ") || "none";
      out.push(`quoted line ${JSON.stringify(q)} must be a shot line exactly, character-for-character; shot lines were: ${spoken}`);
    }
  }
  if (JSON.stringify(script.quotedLines) !== JSON.stringify(quoted)) {
    out.push(`quotedLines must be ${JSON.stringify(quoted)}, got ${JSON.stringify(script.quotedLines)}`);
  }

  const n = script.shots.length;
  if (n < 1 || n > 2) out.push(`a script has 1–2 shots, got ${n}`);
  script.shots.forEach((s, i) => {
    if (s.id !== `s${i + 1}`) out.push(`shot ${i + 1} must have id "s${i + 1}", got "${s.id}"`);
  });

  const total = script.shots.reduce((sum, s) => sum + s.seconds, 0);
  if (n > 0 && (total < SCRIPT_SECONDS.min || total > SCRIPT_SECONDS.max)) {
    out.push(`total duration ${total} s is outside ${SCRIPT_SECONDS.min}–${SCRIPT_SECONDS.max} s`);
  }

  for (const s of script.shots) {
    const words = wordCount(s.line);
    const need = words / WORDS_PER_SECOND + LINE_PAD_SECONDS;
    if (words > 0 && need > s.seconds) {
      out.push(
        `shot ${s.id}: ${words} words need ${need.toFixed(1)} s to speak (words / ${WORDS_PER_SECOND} + ${LINE_PAD_SECONDS}) but the shot has ${s.seconds} s; shorten the line or lengthen the shot`,
      );
    }
    // Quoted lines are the user's words and stay as written; everything else must be speakable as-is.
    if (!quoted.includes(s.line)) {
      const digits = s.line.match(/\p{Nd}+/gu);
      if (digits) out.push(`shot ${s.id} line has digits ${digits.map((d) => `"${d}"`).join(", ")}; spell numbers out as words`);
    }
  }

  const look = looseWords(script.character.look);
  if (look < MIN_LOOK_WORDS) {
    out.push(`character.look has ${look} words; needs at least ${MIN_LOOK_WORDS} words of concrete visual detail`);
  }
  return out;
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

export interface WriteScriptOpts {
  llm: LlmProvider;
  maxAttempts?: number;
}

export async function writeScript(
  idea: string,
  { llm, maxAttempts = 3 }: WriteScriptOpts,
): Promise<{ script: Script; attempts: Attempt[] }> {
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
    const reason = [...(r.notes ?? []), ...problems].join("; ");
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
