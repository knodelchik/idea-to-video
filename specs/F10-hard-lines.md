# F10 — Hard lines: fair verbatim gate, fail before paying

## Goal
A skeptical reviewer will type hard ideas: numbers, money, times, accented names, emoji, abbreviations, Ukrainian, nested
quotes, three lines. Today about half of them pass mock mode and then fail **every** paid run (evidence:
`docs/hard-ideas-report.md`, `evals/hard.jsonl`, `evals/results/2026-10-18-hard-stress.json`). Two rules:
1. **Same spoken words must pass.** If a human hears exactly the written words, the gate passes, whichever way ASR
   spells them ("1987" / "nineteen eighty-seven", "Zoë" / "Zoe", "FBI" / "F.B.I.", "3:15 a.m." / "3.15 AM").
2. **Impossible lines fail before the first paid call**, with a message a user can act on.

A word that is really missing, added or changed must still fail. That is the product promise; never loosen it.

## Scope
- `src/verbatim.ts`:
  - Fold diacritics on both sides (NFD, strip `\p{M}`), after NFKC.
  - Abbreviation table applied to both sides: `dr→doctor`, `mr→mister`, `mrs→missus`, `ms→miz`. Runs of single letters collapse
    (`f b i`, `F.B.I.`, `FBI` → `fbi`; `a.m.`, `a m`, `AM` → `am`; same for `pm`).
  - Times: `3:15`, `3.15` followed by am/pm, `3:15am` → the same tokens.
  - Numbers: compare with **alternative readings**. A number span on either side may match any of its readings:
    - integers 1100–2099 without separators: year reading ("nineteen eighty seven", "two thousand five",
      "twenty twenty six") **and** cardinal;
    - money `$4.50`: "four dollars fifty cents" | "four dollars and fifty cents" | "four fifty"; `$20`: "twenty
      dollars";
    - `24/7`: "twenty four seven"; percent as today.
    Design it so `compareWords(expected, heard)` returns pass iff some reading of expected equals some reading of
    heard token-for-token; WER/ops are reported against the closest pair. Keep the expansion bounded (cap the
    number of combinations; document the cap).
  - Emoji / `\p{Extended_Pictographic}`: not words. `splitDelivery` moves them out of the spoken text (like
    delivery tags), so they never become expected words.
  - Non-speech tags: `[laughs]`, `(laughs)`, `*sighs*` are removed from the **heard** text as well. When the line
    carries a laugh tag, `ha`, `haha`, `heh` heard outside the expected words are ignored. Ignored tokens are
    reported (so the attempt can log them).
  - `extractQuotedLines`: nested double quotes (a fragment that starts or ends with whitespace, or two quotes with
    no narrative between them) → a clear error, raised before any LLM call: "nested double quotes: use single
    quotes inside the line".
- Pre-spend guards (in `src/nodes/script.ts`, run before the first LLM call where possible, otherwise in
  `scriptProblems` so the LLM gets the reason):
  - A spoken line with non-Latin letters (Cyrillic etc.) → fail before any call: "only English lines are supported
    in this PoC (no video model officially supports Ukrainian speech yet); write the line in English". The README
    already says English only; now the code enforces it.
  - A single quote that needs more than 15 s at the current speaking-rate rule → fail before the LLM.
  - More quoted lines than fit: a shot line may now hold **several quoted lines in order** (each quote must be a
    contiguous part of exactly one shot line, in idea order). Only fail fast when they cannot fit 2 shots × 15 s.
  - A line whose speaking time exceeds `LIPSYNC_MAX_SECONDS` is allowed but recorded on the script attempt as
    "no lip-sync fallback for this line" so the manifest says it up front.
- `src/providers/mock.ts`: the mock script responder sizes shots with `wordCount` from `verbatim.ts` (today it
  counts raw whitespace words, so `pnpm make --mock` fails on a line with "1987"). Mock ASR must not hide
  unspeakable tokens: it hears only speakable words.
- `src/providers/gemini.ts`, `gemini-judge.ts`: every model in each `DEFAULT_*_MODELS` chain has a price (look up
  current Gemini API pricing; record the source and date). A test asserts it.
- `evals/hard.jsonl` joins the eval set: `evals/run.ts` accepts `--set hard` (default stays `ideas.jsonl`).

## Acceptance
1. `tests/verbatim.test.ts` gains a table of **must-pass** pairs (at least): "1987"/"nineteen eighty-seven",
   "It's 3:15 a.m."/"It's 3.15 AM", "$4.50"/"four fifty", "$4.50"/"four dollars and fifty cents",
   "Zoë"/"Zoe", "Nguyễn"/"Nguyen", "the FBI"/"the F.B.I.", "Dr. Patel"/"Doctor Patel", "24/7"/"twenty four seven",
   "Go! 🚀"/"Go!", "Okay. [laughs]"/"Okay. Ha ha." — and **must-fail** pairs (at least): "1987"/"1988",
   "$4.50"/"four dollars", "Zoë"/"Zoey", "the FBI"/"the CIA", "Meet me at 3:15"/"Meet me at three",
   "You & me"/"you me", "It's $20"/"it's twenty".
2. Pre-spend guards: a Cyrillic line, nested quotes, and a 40-word quote each fail with the documented message and
   **zero** LLM / image / video calls (call counters).
3. Three short quoted lines fit in 2 shots (mock LLM returns a script with two quotes in one shot) and pass.
4. `npx tsx evals/run.ts --mock --set hard` exits 0 and writes results; ideas the PoC deliberately rejects
   (Ukrainian) are recorded as clean rejections, not crashes.
5. `npx tsx src/cli.ts 'An old man fixes a clock. He says: "It stopped in 1987, at 3:15 a.m., and so did I."' --mock --json` → ok.
6. `pnpm verify` green.
