# Where AI got it wrong

Append-only. Format: `- [feature] what went wrong → how it was caught → fix`.
Kept honest on purpose: this is the raw material for "how I worked with AI".

## Before the harness (research + setup, written by the human with Claude Code)

- [research] Claude's built-in model knowledge was months out of date: it proposed building around Kling/Veo 3.1
  without knowing Veo 3.1 previews on the Gemini API shut down on 2026-10-22 and the Sora 2 API closed on
  2026-09-24 → caught by forcing the research agents to cite a dated source for every claim (VERIFIED/UNCERTAIN)
  → model choice moved to a measured benchmark (F09) instead of a reputation guess.
- [research] Early plan assumed "the company uses Kling, so build for Kling" (from a half-remembered fact) →
  research showed their public stack is Google-centric and Kling 3.0 ranks ~15–19 on the arena → providers stay
  behind one interface; the choice is a config value.
- [harness] First `verify.sh` used `grep -P` (lookahead) for the import-boundary check; macOS grep has no `-P`, so the
  error was hidden by `2>/dev/null`, so the check would always pass → caught on a re-read before the first run → rewritten as `grep | grep -v` (still worth a crafted-violation test).
- [harness] First harness run died instantly: the log directory is gitignored, so it didn't exist on a fresh clone,
  and the redirect failed before the script could `mkdir` it → caught on the first run → created up front.
- [F01] The first draft of the schema tests included a "rejects a script longer than 30 s" case, but shots are capped
  at 2 × 10 s, so a total over 30 s can't happen (it would only ever have passed because of a shot-level error) → caught while
  tracing the test by hand → replaced with boundary tests (8 s and 2 × 10 s accepted, a 25 s shot rejected at
  `shots.0.seconds`); the dead 30 s ceiling is noted in the spec's Decisions.
- [F01] `normalize` dropped every character that wasn't a letter or digit, including symbols that are spoken (`&`, `$`, `%`), so
  `compareWords("You & me", "you me")` passed even though a spoken word was missing → caught by the reviewer
  on attempt 1 → those symbols are now spelled out as words, every other symbol is kept as its own token, and tests cover the missing-word cases.
- [harness] Implementer agents in the first run could not execute a single command: `--allowedTools $TOOLS` was
  unquoted, so the shell split `Bash(pnpm *)` and globbed the `*`. The agent wrote code "traced by hand" and said so
  in the spec → caught by reading `permission_denials` in the run log → quoted, comma-separated `Bash(cmd:*)` rules,
  verified with a probe run (0 denials).
- [harness] `git add -A` in the harness committed local agent-tool state (`.omc/`) → caught by reading the commit
  stat → ignored and purged from history before anything was pushed.
- [F01] The reviewer agent rejected the first F01 attempt that the implementer and the gate had passed:
  `normalize()` dropped `$ & %`, so "It's $20" matched "it's twenty" (a missing spoken word passed the verbatim gate)
  → fixed on attempt 2 with tests. Proof that the separate reviewer earns its cost.
- [spec] My own F01 spec allowed 2 shots × max 10 s but a 30 s ceiling that could never fire; the implementer flagged
  it in Decisions → shot range widened to Seedance's 4–15 s in F05.
- [F02] I assumed that re-encoding to AAC keeps audio exactly as long as the video. The real ffmpeg round-trip test
  showed concat + loudnorm leaving the audio 0.1 s longer than a 3.0 s video (AAC frame padding plus loudnorm's
  resample), so the file was 3.1 s long → found by probing each stage → `-shortest` in `concatArgs`/`loudnormArgs`,
  asserted by the tests. A test that checked only the arg arrays would have passed.
- [F02] My mock ASR `replace` fault matched whole tokens, so `{watch: …}` never matched `"watch."` and the fault
  silently did nothing → caught because the fault test asserts the altered text → punctuation-insensitive match.
- [F02] MockLipsync/MockTalking copied `<audio>.transcript.json` with `copyFile`, which ignored the
  `.source.json` links that MockAsr follows. Linked or silent audio threw ENOENT, and the tests only used direct
  TTS output → caught by the reviewer → resolve with `readTranscript` and write only if a transcript exists. Added
  a test with linked and bare audio.
- [F03] Wired the live LLM as `{ llm: GeminiLlm.fromEnv(env), ...overrides }`. A test passing `{ ...mocks, llm: undefined }`
  would have replaced the adapter with `undefined` (spread copies explicit undefined keys) and also built a client
  needlessly → caught while writing the createProviders test → `{ ...overrides, llm: overrides.llm ?? GeminiLlm.fromEnv(env) }`.
- [F04] I assumed Gemini TTS used `generateContent` with `responseModalities: ["AUDIO"]` and
  `speechConfig.voiceConfig.prebuiltVoiceConfig`. The current speech-generation docs show only the Interactions API
  (`/v1beta/interactions`, `speech_config: [{voice}]`, audio in `steps[].content[]`) → caught by reading the docs before
  writing the adapter → built the request from the documented body and asserted it with a fake fetch.
- [F04] My first acceptance-1 test expected `"it all"` vs `"everything"` to produce `sub + ins`. Levenshtein has two
  equally cheap alignments (`ins + sub` came out) → caught when the test failed → switched to a paraphrase with one
  unambiguous op (`watch` → `clock`), so the test checks the gate rather than the tie-break.
- [F05] I planned to send `seed: variant` and an integer `duration` to Seedance on fal, as the BytePlus examples do.
  fal's llms.txt has no `seed` input, and `duration` is a string enum (`"4".."15"`) → caught by reading the docs
  before writing the adapter → the fal input sends `String(seconds)` and no seed. A test asserts the exact input, and
  a mutation (integer duration) makes that test fail.
- [F05] I wrote `toMatchObject({ verbatim: undefined })` to assert that a silent shot has no gate result. That
  matcher requires the key to be present → caught when the test failed on correct code → switched to
  `not.toHaveProperty("verbatim")`.
- [F05] My Seedance adapter returned the *requested* `seconds` and a hard-coded `hasAudio: true`. The node believed
  the adapter's report, and for a lip-synced shot it reported the base clip's length, not the synced file's. That
  breaks hard rule 4, and the tests passed only because the mocks happen to tell the truth → caught by the reviewer
  on attempt 1 → the adapter runs ffprobe on the downloaded file (`probe` is injectable). The node measures every
  clip it returns, including the synced one. New tests use a lying `MockVideo` subclass and a lip-sync that trims
  to 5 s, so an echoed value would fail.
- [F05] My fake fal `storage.upload` numbered URLs by call order (`up/1`, `up/2`). The nano-banana adapter uploads refs
  in parallel, and `falUpload` reads the file first, so the numbering followed whichever read finished first. The test
  also passed `[kf, kf]`, which could never catch a reorder → caught by the reviewer as a flaky `pnpm verify` (1 failure
  in 2 runs) → the fake URL is now a hash of the uploaded bytes, the tests use two different files, and a mutation
  (reversed refs) fails the test.
- [harness] F05 was BLOCKED after 3 attempts. Not a loop: each review found a *new* real defect (durations taken
  from the request instead of the file; a flaky ref-order test the reviewer caught by running verify twice; attempts
  lost when the lip-sync fallback throws). Root causes on my side: the reviewer revealed issues one per round, and
  the gate log was empty on success so the reviewer had no evidence → reviewer now must report all blocking issues
  in one pass and run verify twice; gate logs its green output; human notes appended to the spec; re-run.
- [F05] Measured `hasAudio` on native clips but never branched on it; a silent Seedance take went to ASR, which
  live Groq can't handle (`-map 0:a:0` throws) → MockAsr returned an empty transcript for silence, so tests
  passed; caught by review reading groq-asr.ts → silent take is now a recorded failed attempt (no ASR call),
  tested with a test-local ASR that throws on files without an audio stream.
- [F06] Assumed one-pass `loudnorm=I=-16` delivers −16 LUFS. The e2e run was green, but measuring final.mp4 with
  `ebur128` showed −35 LUFS: dynamic mode barely lifts the quiet mock tone → caught by measuring the output
  instead of trusting the filter name → two-pass linear loudnorm (−15.8 LUFS), plus `aresample,apad`, because
  linear mode dropped ~20 ms of audio and `-shortest` shrank the film to 8.98 s (an exact-8 s script would fail).
- [F06] Named graph nodes after the stages (`script`, `keyframes`), but LangGraph rejects node names that equal
  state keys → the first CLI run failed at compile → renamed to `writeScript` / `drawKeyframes`. Separately,
  parallel Send failures arrive as "Multiple errors occurred during superstep N" (the resume test caught the
  unreadable manifest error) → `runError` joins the inner `errors[]` messages.
- [harness] My deny rule `Read(./.env.*)` also matched `.env.example`, so the F06 agent couldn't update it. It said
  so honestly under "Blocked" instead of working around the rule → human wrote `.env.example`, narrowed the rule.
- [F07] I keyed cached judge verdicts only by the judged files' bytes. Mock regeneration takes are byte-identical
  stills, so take 2's frames hit take 1's cached verdict and the scripted second score never reached the node. The
  test "4 → 7: the better take wins" failed with scores [2, 2] → the content-addressed clip name now joins the
  verdict key. Also, my GeminiJudge test fixture used an unpriced model, so the invalid-reply case "cost" $0 and
  hid whether the cost was carried → the fixture now uses priced models.
- [F08] I wrote an aggregate test that expected the mean judge attempts to be 4/3. The fixture row overrode
  `judgeScores` but not `attemptsByStage`, so the right answer was 2/3 → the red test caught it → I fixed the
  expectation (the code was right). Also, I imported a nonexistent `words` from `src/verbatim.ts` → typecheck
  caught it → I added a local whitespace split.
- [F09] In the report test I expected a 2×1 grid for a table with one ok row and one failed row. Failed rows get no
  cell, so the grid is 1×1 → the red test caught it → I fixed the expectation (the code was right). Also,
  `heard` showed the normalised text ("i kept … sent"), and the end-to-end test caught it → the table now shows the
  raw transcript. I also tried to run `bench.ts --live` (without `--yes`) by hand to show acceptance 2. The repo hook
  blocks any `--live` command → that acceptance is now shown only by the unit test that drives `main(["--live"])`.
- [F03/F07] Two agents independently defaulted the Gemini model chain to `gemini-2.5-flash`, which new AI Studio
  projects can't use (learned the hard way in the previous project) → caught by the human reading the Decisions
  sections → defaults replaced by a chain verified on a fresh key; HTTP 404 now moves to the next model with a note.
