# Chat exports (Part 5)

Two real agent sessions from the harness. They were converted from `claude -p --output-format stream-json` logs by a
small script. Thinking is left out and long tool output is cut. The task prompt itself is built in
`scripts/harness.sh` and does not appear in the stream log.

1. [01-F01-verbatim-gate.md](01-F01-verbatim-gate.md): the implementer builds the verbatim gate, and the gate is
   green. The independent reviewer still rejects it because "It's $20" matched "it's twenty". The fix comes on
   attempt 2.
2. [02-F05-blocked-then-fixed.md](02-F05-blocked-then-fixed.md): the Seedance talking shot. The feature was BLOCKED
   after 3 attempts. A human note went into the spec. On the re-run the reviewer caught a silent clip that would
   have wasted a paid generation.

By F11 the build had taken 26 headless sessions, about $35 at API prices (summed `total_cost_usd` from the logs). The full list of harness runs is in `harness/runs.md`.
