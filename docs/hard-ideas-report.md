# Hard ideas: what breaks before a reviewer finds it

Date: 2026-10-19. Cost: $0. The only live calls were Gemini free-tier script-writer calls; image, video, TTS and ASR
were never called live.

- Ideas: [`evals/hard.jsonl`](../evals/hard.jsonl) (19 ideas, same format as `evals/ideas.jsonl`).
- Harness: [`evals/stress-script.ts`](../evals/stress-script.ts) (`npx tsx --env-file=.env evals/stress-script.ts`;
  `--no-live` replays the cached Gemini drafts in `evals/results/hard-gemini-scripts.json` for $0 and no quota).
- Raw results: `evals/results/2026-10-18-hard-stress.json`.

For each idea the harness ran:
1. `extractQuotedLines`;
2. the real `writeScript` node against live Gemini (model chain + 3 attempts, as in production);
3. pure checks: are the quoted lines verbatim, the seconds, and `normalize()` of every line;
4. a **simulated ASR** check: 1–3 hand-written but realistic Whisper renderings of the line (digits, `AM`, `24-7`,
   ASCII names, `(laughs)`) through `compareWords`. This is the only way to test the verbatim gate's normaliser
   for free, because mock ASR echoes the expected text back and so can never fail on wording;
5. the full graph in mock mode twice: once with the built-in mock writer, and once with the Gemini draft replayed
   through `MockLlm`, so the downstream stages see the real script.

Limits: the ASR renderings are informed guesses, not recordings. Content-policy behaviour of Seedance and the image
models (dark theme, child, real-face filter) can't be tested without paying, so it isn't tested here.

## Outcome per idea

| id | Live script (attempts) | Quotes verbatim | Shots (s: line) | Simulated ASR | Mock graph (mock writer / Gemini draft) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| dialogue-two-speakers | ok (1) | yes | 5: mother's line · 5: son's line, **both given to "Martha"** | 1/1 | ok / ok | **Bad, silent**: the mother says "…, Mom." to herself |
| three-lines | FAIL (3) | no | (Gemini merges 2 lines, or makes 3 shots) | – | FAIL / – | Rejected, but only after 3 wasted LLM calls; impossible from the start |
| long-line-33w (29 spoken words) | ok (1) | yes | 13: line · 5: silent | 1/1 | ok / ok | OK. Lip-sync fallback can't save it (speech ≈12 s > Kling's 10 s cap) |
| numbers-money-time | ok (2) | yes | 11: line · 4: silent | **1/3** | **FAIL** / ok | **Bad**: `1987` → "one thousand nine hundred eighty seven"; `3.15 AM` fails; mock mode crashes |
| unusual-names | ok (1) | yes | 5.5: line · 4.5: silent | **1/3** | ok / ok | **Bad**: `Zoë`≠`zoe`, `Nguyễn`≠`nguyen`, so the gate fails on correct speech |
| ellipsis-emdash-question-exclaim | ok (1) | yes | 6: line · 5 | 1/1 | ok / ok | Good |
| nested-single-quotes | ok (1) | yes | 6: line · 5 | 1/1 | ok / ok | Good |
| nested-double-quotes | FAIL (3) | no | extracted as `"When I say "`, `" you stop. Not "`, `" Now."` | 0/1 | FAIL / – | **Bad**: garbled extraction, confusing error, 3 LLM calls wasted |
| ukrainian-only | ok (1) | yes | 4.5 · 5.5: Cyrillic line | 1/2 (only if ASR returns Cyrillic) | ok / ok | **Bad, paid failure**: accepted, but ASR is forced to `en` and the video prompt says "in English" |
| mixed-en-uk | ok (1) | yes | 4.5 · 5.5: mixed line | 1/2 | ok / ok | Same as above |
| cat-speaker | ok (1) | yes | 4.5 · 5.5 | 1/1 | ok / ok | Good (voice enum forces "male"/"female", which is fine) |
| robot-percent | ok (1) | yes | 6 · 5 | 2/2 | ok / ok | Good: `3%` → "three percent" |
| child-question | ok (1) | yes | 5 · 5 | 1/1 | ok / ok | Script OK. The grandfather isn't in the shot (one character). Child-face policy is untested |
| dark-grave | ok (1) | yes | 4.5 · 5 | 1/1 | ok / ok | Script OK (Gemini didn't refuse). Video policy untested |
| abstract-no-quote ("Loneliness in a big city.") | ok (2) | n/a | 6: "Millions here, yet no one knows me." · 5 | – | ok / ok | Good. The retry fixed a timing miss |
| whisper-tag | ok (1) | yes | 5: `[whispers] …` · 4 | 1/1 | ok / ok | Good: the tag is stripped before the gate |
| abbrev-emoji | ok (1) | yes | 6: `…line two 🚀` · 5 | **0/2** | ok / ok | **Worst**: the 🚀 token can never be heard, so the run is a guaranteed paid failure, and mock says ok |
| very-short-no ("No.") | ok (1) | yes | 5 silent · 4: "No." | 1/1 | ok / ok | OK. Watch for Whisper hallucinating on ~0.3 s of speech |
| ends-laughs-tag | ok (1) | yes | 4 · 5: `… [laughs]` | **1/3** | ok / ok | **Fragile**: a heard "(laughs)" or "ha ha" counts as inserted words |

Totals: the live script stage passed 17/19 ideas; the 2 rejections were deterministic and correct, but late.
14/19 needed a single attempt. Mock graph: 16/19 passed with the mock writer and 17/17 with the Gemini drafts.
**Mock mode passed every idea below that a live run would fail** (emoji, Ukrainian, diacritics, `(laughs)`),
because mock ASR echoes the expected text.

## What it handles well

- Punctuation-heavy lines (ellipsis, em dash, `?`, `!`, single quotes inside the line, curly quotes) normalise
  cleanly and pass.
- Delivery tags (`[whispers]`) are stripped from what the gate expects, and Gemini copies them into the shot line
  verbatim.
- Symbols: `%`, `$`, `&` are spelled out on both sides (`3%` matches "three percent" and "3%").
- Cyrillic survives `normalize()` (no letters lost). The normaliser isn't the problem for Ukrainian; ASR and the
  video prompt are.
- No-quote and abstract ideas: the writer produces a short line, and code checks for digits and timing.
- The retry loop does its job: timing misses come back to the model as concrete numbers and get fixed on attempt 2.
- Model fallback works: 429/503 moved on down the chain and every move was recorded in `attempts[].reason`.

## Ranked failures (by how likely a reviewer hits them)

### 1. Numbers in the line: years, clock times, `a.m.` (very likely; numbers are the first thing people try)
- `1987` is normalised as "one thousand nine hundred eighty seven". Anyone saying "nineteen eighty-seven" fails
  if ASR writes words. Worse, `wordCount` treats it as 6 words, so the shot gets padded with silence.
  `src/verbatim.ts:75-78` (integer rule) and `:27-33` (`numberToWords`).
- `3:15 a.m.` → "three fifteen a m". Whisper's "3.15 AM" → "three point one five am" fails (`:56-62` handles only
  `:`; `a.m.`/`AM` tokenise differently at `:133`).
- `$4.50` → "four dollars fifty cents". A spoken "four fifty" that Whisper writes as words fails (`:103-111`).
- **Mock mode fails on this idea**: `mockScriptResponder` sizes shots with raw whitespace words
  (`src/providers/mock.ts:44,113`), but `scriptProblems` uses normalised `wordCount` (`src/nodes/script.ts:45`).
  The free `pnpm make --mock` therefore ends in "script rejected after 3 attempts". A reviewer's first, free run
  can hit this.
- **Fix:** (a) read 4-digit integers 1100–2099 without separators as years ("nineteen eighty seven", "two thousand
  five"). (b) Compare number spans with *alternatives*: expand each digit/currency/time span into a small set of
  accepted readings ("four fifty" | "four dollars fifty cents" | "four dollars and fifty cents"), and accept a heard
  sequence that matches any of them. (c) Accept `.` as a clock separator when followed by `am|pm|a.m.|p.m.` and
  fold `a.m.`/`a m`/`am` into one token. (d) In the mock responder, use `wordCount` from `verbatim.ts`.

### 2. Accented names: Zoë, Nguyễn, Siobhán (likely; "unusual names" is a classic test)
- `normalize` only applies NFKC (`src/verbatim.ts:125`), so `zoë` ≠ `zoe` and `nguyễn` ≠ `nguyen`. Whisper very
  often writes the ASCII form. Correct speech then fails the gate on every retry, and the fallback burns TTS +
  lip-sync money too. For `Siobhán`, Whisper may write "Shivaun", which no normaliser can fix.
- **Fix:** fold diacritics on both sides (NFD, then strip `\p{M}`). It is symmetric, so it's also safe for
  Cyrillic. For names that are spelled one way and sound another, add an optional per-run
  `aliases: {"Siobhán": ["Shivaun","Shevaun"]}` (or a capitalised-token rule: a name-only substitution is reported
  as `needsReview` instead of failing). Add `unusual-names` to `evals/ideas.jsonl`.

### 3. Emoji (or any `\p{S}` symbol) in a quoted line: a guaranteed paid failure (likely; reviewers love emoji)
- By design, `normalize` keeps symbols as their own tokens (`src/verbatim.ts:134`), so `🚀` is an expected word
  that no ASR will ever output. `scriptProblems` (`src/nodes/script.ts:44-57`) accepts the line, the run pays for
  keyframes, video, retries and the fallback, then fails. Mock mode passes, because mock ASR echoes the 🚀.
- **Fix:** before any spend, in `scriptProblems`, reject a quoted line whose normalised form contains an
  unpronounceable token, with a clear message ("emoji 🚀 can't be spoken; remove it or write it as a word"). Or
  better, treat `\p{Extended_Pictographic}` like a delivery tag in `splitDelivery` (`src/verbatim.ts:204-215`):
  keep it for the prompt and drop it from the expected words. Make `MockAsr` run expected text through a
  "speakable" filter, so mock stops hiding this.

### 4. Two characters in a dialogue (likely; "make them talk to each other")
- The contract has exactly one `Character` (`src/schemas.ts:9-18`), the prompt says "One character"
  (`src/prompts/script.ts:14`), and `Shot` has no speaker. Gemini gave both lines to the mother, who then says
  "…, Mom." to herself. Every check passes, so this is a **silent** semantic failure.
- **Fix (cheap, honest):** add `speaker` to `Shot` and have code reject or flag scripts where the idea's quoted
  lines are attributed to different speakers ("two speaking characters aren't supported yet"). **Fix (real):**
  allow `characters[1..2]`, give each shot a `speaker`, generate one portrait per speaker, and pass the speaking
  character's ref and voice per shot.

### 5. Ukrainian or mixed-language lines: accepted, then fail after spending (likely for this author's reviewers)
- The script stage accepts Cyrillic, and `normalize` keeps it intact. But the Seedance prompt says
  "…once, in English…" (`src/prompts/visuals.ts`, `talkingPrompt`, currently being edited), and Groq ASR is
  forced to `language=en` (`src/providers/groq-asr.ts:73`). Whisper then translates or transliterates ("I waited
  for you all winter", "Mamo, ya vdoma"), and every take fails. The README documents "English only", but no code
  enforces it, so the money is spent first.
- **Fix:** right now, add a pre-spend guard in `scriptProblems`/CLI that rejects non-Latin-script spoken lines
  with the README's explanation. Later, detect the line's language, pass it to ASR (`language=uk`, or omit it for
  mixed lines) and to the video prompt, and per-language number words in `normalize`.

### 6. Nested double quotes (moderately likely)
- `extractQuotedLines` (`src/verbatim.ts:221-229`) pairs `"` greedily, so `"When I say "stop," you stop…"` turns
  into three fragments with leading and trailing spaces. The run burns 3 LLM calls and ends with a confusing
  error.
- **Fix:** validate the extraction before calling the LLM. If a fragment starts or ends with whitespace, or two
  quotes touch with no narrative between them, fail fast with "nested double quotes: use single quotes inside the
  line". Optionally, pick the outer span from the first `"` after `:` to the last `"`.

### 7. More quoted lines than shots (moderately likely)
- 3 quotes vs. a 2-shot maximum (`src/schemas.ts:26` id enum; `src/nodes/script.ts:23-34`) can never be satisfied,
  but `writeScript` (`src/nodes/script.ts:85-91`) still makes 3 LLM calls before failing. Gemini tries to merge
  two quotes into one shot, which the exact-equality check (`:24`) then rejects.
- **Fix:** let a shot line contain several quoted lines in order (check that each quote is a contiguous substring
  of one shot line, in idea order), so 3 short questions fit in 2 shots. If they still can't fit
  (`quoted.length` > 2 and too long), fail fast before the first LLM call.

### 8. Trailing `[laughs]` / non-speech in the audio (moderate)
- `splitDelivery` strips tags from the *expected* text only (`src/nodes/gate.ts:31`). If the model actually
  laughs, Whisper may write "(laughs)" or "Ha ha ha", which count as inserted words and fail the gate.
- **Fix:** strip `(…)`/`[…]` spans from the *heard* transcript too, and when the line carries a laugh tag, ignore
  inserted laughter tokens (`ha`, `haha`, `heh`) outside the expected span. Log what was ignored in `attempts[]`.

### 9. Abbreviations: Dr., Mr., FBI (moderate)
- `Dr.` → "dr", while Whisper may write "Doctor". `FBI` vs "F.B.I." → "f b i" (3 tokens) fails. Same for
  `a.m.`/`AM` (see #1).
- **Fix:** add a small abbreviation table applied to both sides (`dr→doctor`, `mr→mister`, `mrs→missus`, `ms→miz`),
  and collapse runs of single letters (`f b i` → `fbi`, `a m` → `am`).

### 10. Script cost recorded as $0 for half of the default model chain (low visibility, but a reviewer reading `manifest.json` will notice)
- `DEFAULT_SCRIPT_MODELS` includes `gemini-3.5-flash` and `gemini-flash-latest` (`src/providers/gemini.ts:35`),
  but `GEMINI_PRICES` (`:21-31`) doesn't. The manifest notes "no price for model …; cost recorded as 0". The
  pre-call estimate does use the dearest known price, but the cost actually recorded is $0. It is noted rather
  than silent, but it is still wrong.
- **Fix:** add the missing prices, and add a unit test that every model in every `DEFAULT_*_MODELS` chain has a
  price.

### 11. Long quoted lines vs the lip-sync fallback (lower)
- A 29-word line got a 13 s shot (correct). If native speech misses, the fallback has to trim at speechEnd
  (≈12 s) + tail, which is more than Kling's 10 s cap (`src/providers/lipsync.ts:23`, `src/nodes/visuals.ts`
  `fitForLipsync`). The run fails clearly, but only after paying for 2 native takes and a TTS track. Lines over
  ~36 words (`(15 − 0.8) × 2.6`) can't fit any shot and are rejected after 3 LLM calls.
- **Fix:** in `scriptProblems`, warn (or record `needsReview`) when a line's speaking time exceeds
  `lipsync.maxSeconds`, so the run knows up front that it has no fallback. Fail fast before the LLM when a single
  quote needs more than 15 s.

## Not tested ($0 rule) and worth a cheap live check later
- Seedance/image moderation on `dark-grave` (grave + shovel) and `child-question` (a 7-year-old's face; real-face
  and minor filters). `PolicyRejectedError` is handled only for the real-face case (text-only retry); other policy
  rejections end the shot.
- Whisper on a single-word, ~0.3 s line ("No.").
