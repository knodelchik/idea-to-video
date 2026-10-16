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
