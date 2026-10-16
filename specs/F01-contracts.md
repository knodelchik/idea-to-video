# F01 — Contracts and the verbatim gate

## Goal
Every stage talks through typed, validated data. The one hard product rule — *the line is spoken word for word* —
is checked by code, not trusted to any model. This feature builds the vocabulary for everything else.

## Scope
- `src/schemas.ts` — Zod schemas + inferred types:
  - `Character { name, look, voice: { gender: "female"|"male", age: "young"|"adult"|"older", tone } }`.
    `look` is a concrete visual description (age, hair, face, wardrobe) usable by an image model.
  - `Shot { id: "s1"|"s2", camera: "close-up"|"medium close-up"|"medium", visual, motion, emotion, line, seconds }`.
    `line` is the exact text spoken in the shot (may be `""` for a silent shot). `seconds` 3–10.
  - `Script { promptVersion, title, logline, setting, character, shots (1–2), quotedLines: string[] }` with a
    refinement: total seconds 8–30, at least one non-empty line.
  - `Transcript { text, words: { word, start, end }[] }`.
  - `VerbatimResult { expected, heard, wer, ops: { type: "sub"|"del"|"ins", expected?, heard? }[], pass }`.
  - `Attempt { stage, shotId?, n, provider, ok, reason?, costUsd, ms }`.
  - `RunManifest { runId, idea, mode: "mock"|"live", createdAt, script?, attempts, costUsd, final?, verbatim?, ok, error? }`
    where `final = { path, seconds, width, height, hasAudio }`.
- `src/verbatim.ts`:
  - `normalize(text)`: NFKC, lowercase, unify apostrophes (’ ʼ ‘ → '), drop punctuation (keep intra-word
    apostrophes), hyphens/dashes → space, English numbers written in digits → words (0–999 999, incl. "3:15"
    → "three fifteen", ordinals optional), collapse whitespace. Pure, no dependencies.
  - `compareWords(expected, heard): VerbatimResult` — token-level Levenshtein alignment with ops; `wer = (S+D+I)/N`;
    `pass = wer === 0`.
  - `extractQuotedLines(idea): string[]` — text inside "…", “…”, «…», „…“ exactly as written (no trimming of
    inner punctuation). Single quotes are **not** delimiters (apostrophes).
- `tests/verbatim.test.ts`, `tests/schemas.test.ts`.

## Acceptance
1. `normalize("Don’t—stop! It's 3 o'clock.") === "don't stop it's three o'clock"`.
2. `compareWords("Meet me where it started.", "meet me where it all started")` → one `ins` op, `pass=false`,
   `wer = 0.2`.
3. `compareWords("I kept the watch.", "I kept the watch")` → `pass=true` (punctuation/case are not errors).
4. Substitution, deletion and insertion are each covered by a test; empty `heard` gives `wer = 1`.
5. `extractQuotedLines` handles all four quote styles, multiple quotes, and ignores `it's`.
6. Schema tests: a 7 s script, 3 shots, or all-empty lines are rejected with readable messages.
7. `pnpm verify` green.

## Constraints
- No runtime dependencies added.
- Do not weaken the gate: a word-level difference must never pass.

## Decisions
_(implementer fills in)_

## Blocked
_(only if needed)_
