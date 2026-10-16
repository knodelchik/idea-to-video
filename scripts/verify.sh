#!/usr/bin/env bash
# The single definition of "done" for agents and humans. Fails fast, prints only what matters.
set -uo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nVERIFY FAILED at: %s\n' "$1" >&2; exit 1; }

step "typecheck"
npx tsc --noEmit -p . || fail "typecheck"

step "unit tests"
npx vitest run --reporter=dot --passWithNoTests || fail "unit tests"

step "no skipped / focused tests"
if grep -rnE '\b(it|test|describe)\.(skip|only|todo)\b|\bxit\(' tests src 2>/dev/null; then fail "skipped or focused tests"; fi

step "architecture boundaries"
if grep -rnE "from ['\"]\.\./nodes" src/providers 2>/dev/null; then fail "providers must not import nodes"; fi
if grep -rnE "from ['\"]\.\./providers/" src/nodes 2>/dev/null | grep -v "providers/index.ts"; then fail "nodes import providers only via providers/index.ts"; fi

# Mock end-to-end: the whole pipeline with zero-cost providers must produce a valid video.
if [ -f src/cli.ts ]; then
  step "mock end-to-end"
  out=$(npx tsx src/cli.ts "A tired barista finds a note in the tip jar. She reads it aloud: \"Meet me where it started.\"" --mock --json 2>&1 | tail -1) || fail "mock e2e run"
  node -e '
    const r = JSON.parse(process.argv[1]);
    const bad = [];
    if (!r.ok) bad.push("ok=false");
    if (!(r.seconds >= 8 && r.seconds <= 30)) bad.push("duration " + r.seconds);
    if (r.verbatim?.wer !== 0) bad.push("verbatim wer " + r.verbatim?.wer);
    if (bad.length) { console.error("mock e2e:", bad.join(", ")); process.exit(1); }
    console.log("mock e2e ok:", r.finalPath, r.seconds + "s");
  ' "$out" || fail "mock e2e result"
fi

printf '\nVERIFY OK\n'
