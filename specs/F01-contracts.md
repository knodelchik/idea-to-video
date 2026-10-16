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
- **No new dependencies.** Zod 4.6.7 was already in `package.json`; `verbatim.ts` imports nothing at runtime
  (only `import type` from `schemas.ts`).
- **Readable errors:** `formatIssues(err)` in `schemas.ts` gives one `path: message` line per issue, short enough
  to send back to the LLM as a retry reason. I didn't use `z.prettifyError` because its multi-line `✖ … → at` format
  is harder to grep and harder to feed back to a model.
- **Script refinements** sit in one `superRefine`: shot count 1–2 (message says how many arrived), shot ids
  must be `s1`,`s2` in order, total 8–30 s, at least one non-blank line. The count check is there rather than in
  `z.array().min/max` so the message can include the actual count. Note: shots are capped at 2 × 10 s, so the
  real ceiling is 20 s and the 30 s bound can never fire; I kept it to match the product rule.
- **I did not add a quotedLines ⊂ lines check to the schema.** It needs `normalize` and belongs to the script stage (F03),
  where a failure turns into a retry. Putting it in the schema would make `schemas.ts` depend on `verbatim.ts`.
- **VerbatimResult** also has a schema refine: `pass === (wer === 0) === (ops.length === 0)`, so a hand-built result
  can't forge a pass. `expected`/`heard` hold the **normalised** text, because that's what the ops refer to.
- **WER with empty expected:** silence vs silence gives wer 0 (pass). Any heard word gives wer 1 (fail), which avoids dividing by 0.
- **Normalisation choices:** no "and" in numbers ("one hundred five"), because ASR output rarely has it.
  Times: `3:15`→"three fifteen", `10:05`→"ten oh five", `7:00`→"seven o'clock". Ordinals 1st…999 999th. Decimals
  are spoken digit by digit ("three point five"). Thousands separators are handled (`1,234`). Numbers outside the
  range stay as digits. Contractions are **not** expanded ("don't" ≠ "do not"): the gate stays strict, as the
  constraints require. Punctuation is replaced by a space (not deleted), so `a,b` never merges into one token.
- **Symbols are never dropped (attempt 2 fix).** Attempt 1 removed every non-letter, so `"You & me"` passed against
  `"you me"`, which broke "a word-level difference must never pass". Now:
  - Spelled out (before numbers, so amounts still get spelled): `&`→and, `%`→percent, `+`→plus, `=`→equals,
    `@`→at, `°`→degrees; `$N`/`€N`/`£N` → "N dollars/euros/pounds" (singular for 1), with an optional 2-digit
    sub-unit (`$3.50`→"three dollars fifty cents", `$0.99`→"ninety nine cents", `£` uses penny/pence); a `-`/`−`
    directly before a digit, and not inside a word or range, → "minus" (`-5`→"minus five", but `3-5` stays two numbers).
  - Every other symbol (`\p{S}`: `~ ♥ ^ | < >`, emoji, plus the spoken punctuation `# § ‰`) is **kept as its own
    token**, with any combining marks or variation selectors attached. So `"#1 fan"`→`"# one fan"`, which fails against
    `"one fan"` and also against `"number one fan"`. That is deliberately strict: when a reading is ambiguous
    (`#` = number/hash/hashtag) the gate fails and does not guess. The script stage (F03) should keep these out of lines.
  - Rejected: (a) a big table of readings for every symbol: the ambiguous ones would guess, and a wrong guess can
    turn a real difference into a pass. (b) Dropping symbols only when the other side lacks them: then the
    comparison is no longer the same normalisation on both sides.
  - Known strict failures (they fail, never pass falsely): suffix currency (`20€`), scale words (`$5 million` →
    "five dollars million"), `$3.505`, and readings like "three fifty" for `$3.50`.
  - `` ` `` is also treated as an apostrophe, because it is a symbol now and would otherwise become a token inside `don`t`.
- **Quotes:** `"…"`, `“…”`, `«…»`, `„…“` (also `„…”`) are matched by one regex in order of appearance. Empty quotes are skipped.
  Inner text is returned untouched, spaces included.
- **Docs checked:** I confirmed the installed version (4.6.7) from `node_modules/zod/package.json` and found
  `prettifyError` in `zod/v4/core/errors.d.ts`. I didn't fetch any web docs. The Zod 4 APIs used (`superRefine` +
  `ctx.addIssue({code:"custom"})`, `refine(fn,{message,path})`, `z.iso.datetime()`) come from memory of the v4 API.
  The reference is https://zod.dev/api; reviewer, please check these first if typecheck fails.
- **Verification caveat:** in this session every command that runs code (`pnpm verify`, `npx vitest`, `npx tsc`)
  and the LSP diagnostics tool needed an approval that the non-interactive session couldn't grant. The tests
  were written first, and the implementation was traced by hand against each assertion. The Stop hook and the
  harness run `pnpm verify` independently. Attempt 2 had the same restriction (`pnpm verify`, `pnpm test`,
  `npx vitest` all needed approval), so the new symbol tests were traced by hand against the code too.

## Blocked
_(only if needed)_
