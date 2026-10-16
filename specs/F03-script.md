# F03 — Script writer with deterministic validation

## Goal
Turn the idea into a `Script` via structured output. The model writes; code validates; failures go back to the
model as concrete notes. Quoted lines from the idea are copied **exactly** — the model may not "improve" them.

## Scope
- `src/prompts/script.ts` — `SCRIPT_PROMPT_VERSION` and the system prompt. Micro-drama craft for a single vertical
  beat: hook in the first two seconds, one character, one location, a clear emotion, close framing that keeps the
  face large (needed for lip-sync), lines that sound spoken. Explicit rule: if the idea contains quoted text, that
  text is the line, character-for-character; otherwise write one short line (≤ 16 words), numbers spelled out.
- `src/nodes/script.ts`:
  - `scriptProblems(script, idea): string[]` — deterministic checks:
    every `extractQuotedLines(idea)` item equals some shot `line` **exactly**; `quotedLines` equals that list;
    1–2 shots; total 8–30 s; per shot `wordCount(line) / 2.6 + 0.8 <= seconds`; non-quoted lines contain no digits;
    `character.look` has ≥ 12 words.
  - `writeScript(idea, { llm, maxAttempts = 3 })` → `{ script, attempts }`: on problems, re-prompt with the previous
    JSON and the problem list. After `maxAttempts`, throw `ScriptError` with the last problems.
- `src/providers/gemini.ts` — live `LlmProvider` on `@google/genai` with JSON schema from `z.toJSONSchema`;
  model chain from `SCRIPT_MODELS` (comma-separated, first available wins; 429/503 → next model). Key: `GEMINI_API_KEY`.
- `tests/script.test.ts` with the mock LLM.

## Acceptance
1. A canned script that paraphrases the quoted line ("Meet me where it all started") is rejected; the second
   prompt contains the problem text; a correct second answer passes.
2. Duration, shot-count, digit and speakability problems each produce a specific message.
3. After 3 bad answers `ScriptError` is thrown and includes the problems; 3 attempts are recorded.
4. Without quotes in the idea, a valid generated line passes and `quotedLines` is `[]`.
5. Gemini adapter is unit-tested only through an injected fake client (no network).
6. `pnpm verify` green.

## Decisions
_(implementer fills in)_
