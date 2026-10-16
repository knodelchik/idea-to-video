# Specs

Each feature is a contract between the human (who writes the spec) and the agents (who build it).

A spec has:

- **Goal** — one paragraph, the why.
- **Scope** — files to create/change. Anything outside needs a reason in *Decisions*.
- **Acceptance** — checkable statements. Each maps to a test or a command in `features.json` → `accept`.
- **Constraints** — what must not happen.
- **Decisions** — filled in by the implementer: choices made, alternatives rejected, new dependencies.
- **Blocked** — filled in by the implementer only if an acceptance item can't be met honestly.

The harness (`scripts/harness.sh`) runs: implementer agent → `pnpm verify` + `accept` commands → independent
reviewer agent → commit + mark `passing`, or feedback → retry (max 3) → `blocked`.
