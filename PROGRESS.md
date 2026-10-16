# Progress

Append-only log, one entry per feature, written by the implementer agent and committed by the harness.

## F01 — Contracts and the verbatim gate
- `src/schemas.ts`: Zod schemas + inferred types for `Character`, `Shot`, `Script`, `Transcript`, `VerbatimResult`,
  `Attempt`, `FinalVideo`, `RunManifest`. `Script` enforces 1–2 shots (ids `s1`,`s2`), shots 3–10 s, a total of 8–30 s
  and at least one non-blank line.
- `formatIssues(zodError)` turns a failed parse into `path: message` lines, ready to feed back to a model as the retry reason.
- `src/verbatim.ts`: `normalize(text)` (NFKC, case, apostrophes, dashes, punctuation, numbers/times/ordinals → words;
  spoken symbols spelled out: `& % + = @ °`, `$N`/`€N`/`£N`, `-5` → "minus five"; any other symbol kept as its own token, never dropped),
  `compareWords(expected, heard)` returns `{ wer, ops, pass }`, and `pass` is true only at wer 0.
  `extractQuotedLines(idea)` handles `"…"`, `“…”`, `«…»` and `„…“`.
- Usage: `compareWords(shot.line, transcript.text).pass` is the gate; `ops` says exactly which words differ.
- Tests: `tests/verbatim.test.ts`, `tests/schemas.test.ts`.
