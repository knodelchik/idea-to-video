# F10 — Hard lines: fair verbatim gate, fail before paying

## Goal
A skeptical reviewer will type hard ideas: numbers, money, times, accented names, emoji, abbreviations, Ukrainian, nested
quotes, three lines. Today about half of them pass mock mode and then fail **every** paid run (evidence:
`docs/research/hard-ideas-report.md`, `evals/hard.jsonl`, `evals/results/2026-10-18-hard-stress.json`). Two rules:
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

## Decisions
- **Readings, not fuzziness.** `normalize` now tokenises into *segments*. A plain word has one reading. A span
  (`$4.50`, `1987`, `3:15`, `24/7`) has several, and its first reading is canonical. A span is marked with a
  private-use placeholder character before the old symbol/number spelling runs. That way the rest of the normaliser
  is unchanged and the span can't be spelled twice. `compareWords` expands both sides and aligns every pair (same
  Levenshtein as before). It passes iff some pair has zero ops. WER and ops come from the pair with the fewest ops.
  `normalize` and `wordCount` use the canonical reading only, so `1987` counts as 3 spoken words, not 6.
  - Rejected: dropping numbers on both sides (loses "1987" vs "1988"), and a "close enough" WER threshold (breaks the
    product promise).
- **Cap: `MAX_READINGS = 32` per side.** Spans are checked one at a time, in order. If multiplying by a span's
  readings would pass 32, that span contributes only its canonical reading. A later span is checked on its own, so
  one with fewer readings can still expand (`1981 1982 1983 1984 $4.50 1985`: `$4.50` is capped, `1985` expands; a
  test pins this). Greedy per span keeps more readings than stopping at the first capped span, and both are bounded.
  32 covers five two-way spans in one line, which is more than a
  15 s shot can say. The worst case is 32 × 32 small DPs. A test runs 12 years in one line in < 500 ms.
- **Readings:**
  - Years 1100–2099 without separators: year reading, then cardinal. `20xx` gets "two thousand five" and
    "twenty oh five"; `2010+` gets "twenty twenty six".
  - Money: "W dollars C cents", "W dollars and C cents", "W C" (or "W oh C" for 1–9 cents). Whole amounts get only
    "W dollars", so `$20` / "twenty" still fails.
  - Clock: `H:MM` (or `H.MM` right before am/pm). `:00` → "H o'clock" or "H".
  - `24/7` → "twenty four seven". Percent is unchanged.
- **Diacritics:** NFKC → lowercase → NFD → strip `\p{M}` → NFC. This is symmetric on both sides, and that is why
  the old "keep `\p{M}` after a symbol" rule is gone.
- **Abbreviations** (`dr/mr/mrs/ms`) are a token map.
- **Spelled letters: join only known patterns.** Before punctuation is dropped, dotted initialisms (`F.B.I.`,
  `a.m.`, `P.M.`, `u.s.a`) and hyphenated letters (`F-B-I`) are joined into one token. "AM" and "FBI" are already one
  token. Space-separated single letters (`f b i`, `a m`) are never merged, because "I" and "a" are words. Such a run
  becomes a span with readings: as written (canonical), fully joined, and joined with a leading/trailing `a`/`i`
  kept separate (`f b i i` → `fbi i`).
  - Rejected (attempt 1): collapsing every run of single letters after punctuation was dropped. This merged a
    following word: `a.m. I` → `ami`, `F.B.I. I` → `fbii`. It also broke the same words when the ASR wrote the
    initialism as one token (`AM I` → `am i`), so "the same happens on both sides" was false. The pairs
    `At 3 a.m. I left.`/`At 3 AM I left.` and `The F.B.I. I trust.`/`The FBI I trust.` are now must-pass tests.
  - Known limit: a spaced run with an `a`/`i` word in the *middle* of a spelled form is not split three ways. ASR
    engines write initialisms as `FBI` or `F.B.I.`, not as spaced letters.
- **Emoji:** `splitDelivery` returns `emoji?: string[]` instead of putting emoji in `tags`. Tags become TTS/video
  *emotion*, and "🚀" is not a delivery. `talkingPrompt` quotes the spoken text when a line has emoji.
  `\p{Extended_Pictographic}` also covers ♥, ©, ™. So at the *gate*, "I ♥ you" now expects "I you". The spec asks
  for this, and a line with ♥ is almost always decoration. The raw `compareWords("I ♥ you", "I you")` still fails
  (existing test unchanged).
- **`*…*` is a tag only for known non-speech actions** (attempt 3): laugh/sigh/cough/gasp/sniff/sob/yawn/groan/
  chuckle/giggle/cry/hum/… with their inflections, an optional `-ly` adverb, and "clears (his) throat". Any other
  starred text is emphasis (`I *really* mean it.`) and stays in the spoken text, so the word reaches TTS/video and
  the gate. Suffixes are per stem shape so no stem + suffix spells a real word (`grind`, `nodes`). The same list
  decides which `*…*` is dropped from *heard* text.
  - Rejected (attempt 2): every `*word*` as a tag. That silently removed a user's emphasised word from the expected
    text and from the TTS/video input, and the gate still passed.
  - Rejected: refusing any line with non-action `*…*`. Emphasis is a normal way to write a line, and keeping the word
    is the strict choice.
- **Private-use characters** (`\p{Co}`, e.g. the Apple logo U+F8FF from Opt+Shift+K) become spaces in `fold()`,
  before span marking. They are not words, and U+E000–U+F8FF is reserved for span placeholders: before this fix a
  literal one crashed `segments` or was read as span #n. Both sides are folded the same way, and a private-use
  character can never stand in for a span (must-fail tests).
- **Laughter:** `compareWords(expected, heard, { laughter })` removes bracketed non-speech (`[…]`, `(…)`, known `*action*`,
  `<…>`) from *heard* always. With `laughter`, it also drops *inserted* `ha/haha/heh` ops. A laughter token that
  replaces an expected word is still a failure. `VerbatimResult.ignored` (new optional field in `schemas.ts`) lists
  everything dropped, and every gate attempt (voice/video/lipsync/final) appends `ignored non-speech: …` to its
  reason.
- **Gate entry points:** `compareLine(line, heard)` = split delivery + laugh-tag detection. `gate.listen` now
  receives the *raw* line (voice and final gate changed to pass it) so a `[laughs]` reaches the gate.
  `listen` calls `splitDelivery` + `compareWords` itself, not `compareLine`, so the existing spy test in
  `voice.test.ts` still sees that only spoken words are compared.
- **Nested quotes:** `extractQuotedLines` throws `QuoteError` in four cases:
  - an odd number of `"`;
  - two quotes with only whitespace between them;
  - an opening `“ « „` inside a fragment of the same style;
  - a fragment that starts or ends with whitespace, **only when there are ≥ 2 fragments**.

  The last condition keeps the existing F01 test (`" Meet me where it started. "` is one padded quote, not nesting).
  Every nested case in `hard.jsonl` produces ≥ 2 fragments.
- **Pre-spend guards** live in `preSpendProblems(idea)` (`src/nodes/script.ts`). `writeScript` throws
  `IdeaRejectedError` before the LLM, carrying one $0 attempt with provider `pre-spend-check`. The graph records it
  like any node error, and the run ends `ok:false` with the message. The guards:
  - non-Latin letters in a quote (`\p{L}` not `\p{Script=Latin}`): the README message;
  - one quote needing > 15 s;
  - quotes that no in-order split into ≤ 2 groups of ≤ 15 s can hold.

  `scriptProblems` also flags non-Latin letters in a line the model wrote.
- **Several quotes per shot:** quotes are placed greedily in idea order, each as a contiguous substring of one shot
  line. A line that holds quotes may contain nothing else but whitespace, punctuation, tags or emoji, so the model
  can't add words around the user's line. This is stricter than "contiguous part", on purpose (verbatim promise). The
  prompt says so, and the version is bumped to `script-v3`. The mock writer packs > 2 quotes into two shots split by
  the most even word count.
- **Lip-sync note:** `writeScript({ lipsyncMaxSeconds })` (the graph passes `providers.lipsync.maxSeconds`) appends
  `shot sN: line needs X s, over the lip-sync max M s: no lip-sync fallback for this line` to the successful script
  attempt. Speaking time is the same `words / 2.6 + 0.8` rule as the shot check. With no limit (Infinity), there is no
  note.
- **Mock ASR** keeps only tokens with a letter, a digit or a spoken symbol (`speakable`). An emoji that reaches
  expected text fails in mock mode as it would live. The mock writer sizes shots with `wordCount(splitDelivery(…))`.
- **Prices** (https://ai.google.dev/gemini-api/docs/pricing and https://ai.google.dev/gemini-api/docs/models,
  checked 2026-10-19):
  - The pricing page does not list `gemini-3.5-flash`, `gemini-flash-latest` or `gemini-flash-lite-latest`. The
    models page only says `*-latest` "points to the latest release". So they are priced at the current top of their
    family: Flash $0.75 / $3.75, Flash-Lite $0.30 / $2.50. Over-estimating is safe for the budget; under-estimating
    is not.
  - 3.8/3.6 Flash double on 2027-01-01. Noted in the comment, not encoded.
  - A test asserts every model in both default chains has a positive price.
- **Evals:**
  - `--set <name>` reads `evals/<name>.jsonl`. Only plain names are allowed, no paths. The default is unchanged.
  - `IdeaResult.rejected` (optional) marks runs that ended with a `pre-spend-check` attempt. The results table prints
    `rejected` instead of `n`.
  - `evals/stress-script.ts` now treats a nested-quote idea as "no quotes" instead of crashing.
- No new dependencies.
