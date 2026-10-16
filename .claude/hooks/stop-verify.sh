#!/usr/bin/env bash
# Stop/SubagentStop: an agent cannot finish while `pnpm verify` is red.
# Exit 2 = block the stop and hand the failure back to the agent. Loop guard: give up after 4 blocks.
cd "$(dirname "$0")/../.."
input=$(cat)
# Nothing changed in code since last commit -> nothing to verify.
if git diff --quiet HEAD -- src tests scripts specs 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard src tests)" ]; then exit 0; fi
counter=.cache/stop-blocks; mkdir -p .cache
n=$(cat "$counter" 2>/dev/null || echo 0)
if out=$(bash scripts/verify.sh 2>&1); then rm -f "$counter"; exit 0; fi
if [ "$n" -ge 4 ]; then
  rm -f "$counter"
  echo "verify still failing after 4 attempts; stopping. Record the blocker in the spec." >&2
  exit 0
fi
echo $((n + 1)) > "$counter"
{ echo "pnpm verify is failing — you are not done. Fix it, then finish."; echo "$out" | tail -40; } >&2
exit 2
