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
- [preflight] Pre-flight audit of live adapters. Two adapter values came from agents' guesses and had never made a
  real call: the default Seedream model `seedream-5-0-260128` is not a BytePlus model id (the real one is
  `seedream-5-0-lite-260128`), and BytePlus Seedance was costed at a rounded $0.15/s with no fast tier → caught by
  reading the official BytePlus Python SDK source and pricing page before the first paid run → fixed test-first
  (model id, $0.1512/s standard, $0.12096/s fast, cost from `usage.completion_tokens`). `pnpm preflight` now prints
  every live request without sending it.
- [OpenRouter] The brief (mine) said OpenRouter images go through chat completions with `modalities`. The current
  docs have a dedicated Image API (`POST /api/v1/images`, `usage.cost`), and the model pages say an unlisted
  parameter is rejected, so sending `seed` to gemini-nano-banana-2.1 would have 400'd → caught by reading
  `/api/v1/images/models/<id>/endpoints` before coding → the adapter sends `seed`/`resolution` only where listed. Also,
  wiring the new transport showed that `createProviders("live")` had never worked: `talking` sat in the eager key
  check and was never constructed, so every live run died at setup. Mocks and tests always overrode `talking`, which
  hid it → deferred `talking` and `lipsync` (missing key fails on first use), tested.
- [live] First paid run (2026-10-18, via OpenRouter): Seedance 2.0 refused both photoreal AI keyframes with
  `InputImageSensitiveContentDetected.PrivacyInformation` ("may contain real person"). The research had flagged this
  as UNCERTAIN; mocks can't show it. Nothing was billed for the refused jobs ($0.06 spent on script + images) →
  the talking-shot node now retries a real-person refusal once as text-to-video (`textOnly`; the prompt carries the
  look and setting), keeps later takes text-only, and records the switch. Any other policy rejection is still not
  retried. Also: Nano Banana via OpenRouter hit Google's upstream quota (429), so images moved to Seedream 5.0 Flash.
- [live] Text-to-video kept the voice exact but changed the face between shots. Probed the filter for $0.37:
  Seedance refused its *own* last frame as a first frame ($0, refused), but accepted the portrait as an
  `input_references` image, and the face matched the portrait. → the fallback is now a ladder: first frame →
  references (portrait + keyframe) → text only. Also: notes in frame came out as gibberish handwriting, so every image
  and video prompt now asks for no legible writing (prompt version visuals-v2).
- [F10] I routed the gate through a new `compareLine` helper that calls `compareWords` inside `verbatim.ts`. The
  existing `voice.test.ts` spy (vi.mock on the module export) saw zero calls, because a same-module call bypasses the
  mocked export → caught by the two failing spy tests → `gate.listen` now calls `splitDelivery` + `compareWords`
  itself, and the tests are unchanged.
- [F10] My first out-of-order test expected the error to name the *first* quote. Greedy in-order placement finds the
  first quote and reports the *second* one as misplaced → caught when the test failed on its message → the test now
  asserts the quote that is actually unplaceable.
- [F10] A gate test fed MockAsr a transcript longer than the mock tone ("(laughs) … Ha ha."). The speech window then
  ran past the track and `VoiceTrack` refused it → caught by a ZodError → the voice-path test uses one extra laugh
  token, and the bracket case is checked through `listen` alone.
- [F10] I collapsed every run of single letters after punctuation was dropped, and claimed the side effect was
  harmless because "both sides do the same". It isn't: `a.m. I` became `ami` while the ASR's `AM I` stayed `am i`, so
  the same spoken words failed. Same for `F.B.I. I` vs `FBI I` → caught by the reviewer with compareLine → only dotted
  or hyphenated initialisms are joined now. Spaced letters become a span with readings, and the reviewer's pairs are
  must-pass tests.
- [F10] The spec Decisions said the reading cap was sticky ("that span and every later one"). The code checked each
  span on its own → caught by the reviewer → the doc now describes the per-span rule, and a test pins it.
- [F10] Attempt 2 made `splitDelivery` treat every `*word*` as a delivery tag, so `I *really* mean it.` lost
  "really" from the expected text and the TTS input, and the gate passed → caught by the reviewer → only a list of
  known non-speech actions counts as `*…*` tags, and a must-fail test covers emphasis.
- [F10] Span placeholders used U+E000–U+F8FF, but private-use characters already in the input were not removed.
  `wordCount("Hi ")` (Apple logo) crashed, and a literal U+E000 was read as span #0 → caught by the reviewer →
  `fold()` turns `\p{Co}` into spaces before span marking. Tests added.
- [F11] The first idea-attribution heuristic looked for a gendered noun in the first 5 words of the clause, so
  "A teenager hugs her dad and says" made the speaker male. That would have added a false voice-gender rejection
  → caught by running `quoteSpeakers` over every eval idea before wiring it into `scriptProblems` → the subject is
  limited to its first 3 words, and a test pins the case.
- [F11] `quoteSpeakers` only read the text *before* each quote, recognised she/he only as the clause's first
  word, and let a possessive set the gender. So `"A," she says. "B," he asks.` gave [none, she]: the mock run
  passed with one woman saying "Mom, are you sick?" to herself, which is the bug F11 exists to catch. "Then she
  adds" became a second speaker, and "The bride's father" became female. The unit tests only covered the
  `She says: "…"` form, so they passed for the wrong reason → caught by the attempt-1 reviewer → trailing speech
  tags are now parsed, a she/he anywhere in the clause is the subject, leading connectives and possessives are
  skipped, and each form has a test.
- [F11] `subjectOf` took any she/he before the speech verb as the speaker, including one in a leading subordinate
  clause. So 'As she opens the door, her husband asks' gave a female speaker, and the gender check rejected a
  correct script. 'When he walks in, his wife says … He answers' gave he/he, which hid the 'Mom' bug → caught
  by the attempt-2 reviewer with tsx → a leading as/when/while/… clause up to its comma is dropped before
  looking for the subject. Both ideas are tests in tests/script.test.ts.
- [live] 2026-10-19, two hard ideas after F10/F11 ($1.01 + $1.18). Both ok on the first native take, WER 0. The watch
  line was heard as "1987 at 3.15am" and passed only because of the F10 alternative readings (before F10 it would
  have failed after paying). The dialogue gave two characters with two voices. But both rungs (keyframe and
  portrait-as-reference) were refused as a possible real person in all 4 shots, so every shot fell back to
  text-to-video: the watchmaker's face drifts between his two shots. The earlier refs probe passed with a looser
  portrait; the F11 official headshot spec (front, plain grey) looks more like an ID photo. Open question, not fixed.
- [live] Probe for $0.37: the same watchmaker portrait sent **alone** as a reference was accepted and the face held
  exactly (loupe, vest, hair). So the refusal of "portrait + keyframe" came from the keyframe, not the portrait. The
  ladder gained a rung: frame → portrait + keyframe → portraits only → text. Tests updated.
- [live] 2026-10-19, 22 s lighthouse keeper ($2.08): in both shots the keyframe and portrait + keyframe were refused,
  the new portraits-only rung was accepted, and the face (down to an anchor tattoo) held across the two shots. WER 0
  on the first take ("Forty-one" heard as "41"). Judge flagged hand/key warping (7–8/10): hands holding small objects
  remain the weakest visual.
- [F12] `parseStoryboard` checked the "start of a sentence" boundary on the *quote-masked* text, so in
  `Shot 1: she says "Hi." Shot 2: …` the blanked `"Hi."` hid the full stop and beat 2 was never found. Caught by the
  `quoteBeats` unit test (null storyboard). Fix: mask quotes only to find markers; check the boundary on the original.
- [F12] The boundary also needed punctuation *before* a closing quote, so `… "thirty words" Shot 2: …` (no full stop)
  was not a beat. Caught by the pre-spend "beats can't fit 30 s" test, which came back `[]` because the idea was not
  recognised as a storyboard at all. Fix: a closing quote ends the spoken line and counts as a boundary.
- [F13] Attempt 1 bumped `VISUALS_PROMPT_VERSION` to v5 but never ran the full suite, so F11's pinned
  `visuals-v4` test failed the gate. Its tests also never covered the script-prompt bump, the mock writer's cuts, or
  acceptance items 5 and 6. Caught by `pnpm verify` at the gate, then by re-reading the spec's Scope against
  `git diff --stat`. Fix: moved both pins (visuals-v5, script-v6), added the missing prompt/mock code and tests. Run
  `grep PROMPT_VERSION tests` after any version bump.
- [F13] Attempt 2's `chunkLine` merged a lone word ("Yes,") only when the merged cue still fit. Next to a full
  6-word split piece the merge failed silently and a 1-word cue shipped. The ≥ 2-words test passed for the wrong
  reason: none of its lines had a one-word phrase in front of a long one. Caught by the reviewer with three such
  lines. Fix: re-split the lone word together with its neighbour (`rejoin` → `splitRun`), and add those lines to the test.
- [F13] Cards were enabled with `between(t,start,end)`, which is inclusive at both ends, while `settle` makes cues
  abut (end == next start). A frame exactly on the boundary drew two cues, and the degenerate 0.05 s sliver could also
  run past the next start. The args test pinned the overlapping string, so it passed for the wrong reason. Caught by
  the reviewer. Fix: half-open `gte(t,a)*lt(t,b)`, a sliver that never passes the next start, a test that forbids
  `between(`, and a degenerate-timing test.
- [live] 2026-10-19, castle storyboard ($1.37). It worked: both shots came out wide (a full shot at the doors, an
  extreme wide shot of the ballroom), WER 0, and the subtitle was burned in. Two problems. (1) On both wide shots
  Gemini's clip judge returned an **empty** reply (a replay gave the same; the free tier then hit 429, so the cause is
  unconfirmed — a safety block on "ten-year-old girl" is the leading guess). F07 treated a judge failure as "regenerate",
  so the pipeline paid $0.46 for a second take that the judge failed on again. Changed by hand: a judge failure keeps the
  gated take and flags needs-review, with no paid regeneration (test 4b rewritten). (2) Subtitles at 72% height sat on
  the small figure; moved down to 84% (My Muse is ~86%).
- [mock, before a paid run] 2026-10-19: in a storyboard ("Shot 2: in a candlelit throne room an old king … says") the
  F11 speaker detector took "shot" as the speaker, so a script giving the king's and the daughter's lines to one
  person passed. F11's reviewer had tested the sentence forms, not storyboards (F12 came later). Fixed by hand: beat
  markers are stripped, and past a leading place phrase the subject is the first unowned gendered noun. 5 tests added.
- [live] 2026-10-19, final 3-shot storyboard ($1.76): rejected by the final gate. "I'm sorry, I'm sorry" was heard at
  the start of the *silent* wide shot. Fixes, in order of what the evidence showed:
  1. Silent shots are now listened to and muted when words are heard. The redo then heard "Thank you for watching!"
     there, a classic Whisper hallucination on ambient sound, so the first "I'm sorry" was most likely ASR too.
  2. With that shot muted, the final ASR "heard" "The American pronunciation guide presents…" over 5 s of digital
     silence. The final gate now runs silencedetect (-60 dB) and drops words whose middle sits in digital silence,
     reporting them. Nothing can be said in digital silence, so this cannot hide a wrong word.
  3. A redo hit the budget guard: the refused first rung was asked again before the paid clip of a lower rung. The
     ladder now jumps to a rung whose clip is already on disk.
  4. New `--resume <id> --redo <step>`: replays a run from a step; content addressing makes unchanged steps $0.
     The redo of this run cost $0 for video.
- [judge] 2026-10-19: the castle shot scored 3/10. A human review agreed it is a fair score, because there really is a
  second castle stacked on the first (the camera tilts up and Seedance invents more castle). It disagreed on one
  issue: the girl leaving frame on the planned tilt-up looks like real filmmaking. Rubric v6: leaving frame because
  of the planned camera move is fine, and the action must match the shot (direction of movement, who does what).
  Re-judged for free on the same clip: still 2–3/10, and it still says "the character suddenly disappears". It also
  did not flag that she walks away from the gate instead of toward it. Only gemini-3.5-flash-lite answered
  (flash was 429). Lesson: a 3-frame VLM judge can't tell a camera move from a vanishing figure. Fixing that needs
  more frames plus the motion text, or a stronger model; calibrating the judge against human scores is the real fix.
- [F14] Dropped `subject` (the clip's content-addressed name) from the clip verdict's cache key, assuming the clip's bytes in the key made it redundant → test 3b failed: mock takes 1 and 2 have identical bytes, so take 2 reused take 1's verdict (scores [2, 2] instead of [2, 7]) → kept `subject` alongside the bytes. Also: the current Gemini video docs show `processing: { fps }`, but that is the Interactions-API type; `generateContent` parts use `videoMetadata.fps` (checked in the installed SDK's .d.ts, not the web page).
- [F16] The spec (and my first plan) targeted Langfuse's `/api/public/ingestion` batch endpoint with `trace-create` / `generation-create` events → reading the current public-API docs showed it "is deprecated and is sunset on Langfuse Cloud on November 16, 2026" (and the current OpenAPI file no longer even lists it) → exported as OTLP/JSON to `/api/public/otel/v1/traces` instead, still one plain-fetch POST. Also: my hand count for the metrics fixture said 7 video attempts and the test failed with 9. The code was right and my arithmetic was wrong, so I fixed the expectation and kept a mutation check (disabling cached spans / judge meta makes tests 3–4 fail) to show the tests catch real regressions.
- [F15] A test that was meant to show the idea comes after `--` used `indexOf(idea) > indexOf("--")`, which also passes when `--` is missing (-1). Separately, the traversal test accepted 400 *or* 404, so removing the `^[\w-]+$` id rule changed nothing (the containment check alone still gave 404) → both caught by hand mutations (drop `--`, drop the id regex): the tests stayed green → asserted `args.slice(-2) == ["--", idea]`, and gave a real folder named `a.b` an exact 400 / 404 per URL. Also: my first gallery-order expectation put the examples before a newer seeded run (wrong date arithmetic; the code was right). Tooling note: the money hook blocks any Bash command whose text contains the live flag, even inside a heredoc or a code edit, so edits that mention it go through Edit/Write.
- [F17] Assumed the SDK's child method `parent.startObservation(name, attrs, { asType, startTime })` keeps `startTime` → a unit test comparing the exported span's start with the recorded one failed (it got "now"); reading `@langfuse/tracing` 6.0.1's source showed the child method forwards only `asType` → the replay calls the top-level `startObservation` with `parentSpanContext` + `startTime`. Two more wrong assumptions that cost a run each: `InMemorySpanExporter.shutdown()` empties the exporter (our export always shuts down, so tests saw zero spans; fixed with a subclass that keeps them), and the SDK stores a plain-string input as is, not JSON-quoted (fixed the test's parser). Mutations (judges typed `span`, `forceFlush` removed) made the new tests fail, so they test the real thing.
- [F17] Two attempts were rejected because I made dependency changes without recording them: a `minimumReleaseAgeExclude` for the four `@langfuse/*@6.0.1` packages (published the same day, so pnpm's release-age guard blocked them) and a direct `@langfuse/core` dep added for `getGlobalLogger`. I treated both as plumbing, not decisions → the reviewer flagged rule 8 twice → both now have their own Decisions entries (why, scope limited to exact name@version, rejected alternatives, removal date), and the yaml has a comment pointing to them. Lesson: any edit to `package.json` or `pnpm-workspace.yaml` is a Decision.
- [F18] Took the spec's "a cut whose `speaking` is someone else, or null, may only come after the line has ended" literally and also put "the line ends before cut N" in the video prompt for every non-speaking cut → the F13 fixture (speaker → an insert of the watch, nobody on screen) showed the rule also banned inserts, which have no face to misread as the voice → the ordering rule and the prompt now apply only to cuts with people; inserts get "the line continues over the insert in shot N". Also: I wrote the implementation before the new tests, so I ran a mutation (disabled `blockingProblems`) to confirm 6 of the new script tests fail without it.
- [F18] The critic retry loop dropped a script that had passed every code check whenever a rewrite asked for by the critic then failed those checks, and ended at `ScriptError`. So an advisory critic could fail a run that worked before F18 → caught in review (attempt 1); no test covered "critic objects, rewrites fail code checks" → `writeScript` now keeps the last code-valid script it flagged and returns it with `needsReview`/`reviewNotes`, and a test covers that case.
- [F18] After fixing the "rewrites fail the code checks" case, the Decisions and PROGRESS entries said the critic "can never turn a passing run into a failing one". That was only true for critic *replies*: a critic call that threw (Gemini 503 on every model, `BudgetExceededError`) escaped `writeScript`, the run failed, and the manifest kept one $0 `pipeline` attempt instead of the writer's attempts → caught in review (attempt 2) with a provider whose critic throws → `checkContinuity` now catches the error and records it as a failed `continuity` attempt, the script is kept with `needsReview`, and a test throws both a 503 and a budget refusal from the critic. Lesson: "never fails the run" claims need a test for the thrown path as well as the bad-reply path.
