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
- **Contract: `ScriptDraft`** (in `src/schemas.ts`) is what the LLM returns: the `Script` fields minus `promptVersion` and
  `quotedLines`, which code owns. `writeScript` fills them in (`quotedLines = extractQuotedLines(idea)`), so the model
  can never "extract" a quote differently. `scriptProblems` still checks `quotedLines` because it accepts any `Script`.
  `Script` is now `ScriptFields.superRefine(...)`, because zod 4 refuses `.omit()` on a refined object. Its behaviour
  is unchanged.
- **`wordCount`** lives in `src/verbatim.ts` and counts *normalised* tokens. "3:15" counts as two spoken words, so the
  speakability check matches what TTS will actually say.
- The quote check uses strict `===`, not `compareWords`. The spec says character-for-character, so a missing period
  or a case change is also rejected.
- A bad JSON shape (zod issues) is fed back the same way as a `scriptProblems` failure. When the checks pass,
  `Script.safeParse` runs as a final consistency check.
- **Attempts**: one `Attempt` per LLM call: `stage: "script"`. `provider` is `name:model` when the provider reports a
  model. `reason` holds the problems plus any provider `notes`.
- **`LlmResult` gained optional `model` and `notes`**, so a model-chain fallback (429/503) or an unpriced model is
  recorded in the manifest and not hidden (rule 6).
- **Gemini adapter** (`src/providers/gemini.ts`) uses `models.generateContent` with `responseMimeType: "application/json"`
  and `responseJsonSchema`. The schema comes from `z.toJSONSchema` and is filtered down to the keywords the docs list
  (`$schema`, `minLength` etc. are dropped). Zod then re-validates the full contract. The client is injected through a
  small `GenAiClient` interface. Only 429/503 move to the next model. Any other error is rethrown. If every model is
  busy, it throws, listing each one. Rejected alternative: the Interactions API (`client.interactions.create`). The
  current docs show it, but `generateContent` + `responseJsonSchema` is typed in the installed SDK 2.30 and keeps the
  fake small.
- Default `SCRIPT_MODELS` = `gemini-3.8-flash,gemini-2.5-flash` (overridable). Cost = tokens × the price table
  (output includes thinking tokens). An unknown model costs 0 **and** adds a note.
- `createProviders({ mode: "live" })` now builds `GeminiLlm.fromEnv(env)` for `llm` unless it is overridden. Other
  capabilities still refuse.
- No new dependencies (`@google/genai`, `zod` were already present).
- Docs checked: https://ai.google.dev/gemini-api/docs/pricing (prices, 2026-10-16),
  https://ai.google.dev/gemini-api/docs/structured-output (supported schema keywords). SDK types:
  `node_modules/@google/genai/dist/genai.d.ts` (`GenerateContentConfig.responseJsonSchema`, `ApiError.status`).
