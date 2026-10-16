#!/usr/bin/env bash
# Autonomous build loop. For each failing feature in specs/features.json:
#   implementer agent  ->  external gate (pnpm verify + the feature's `accept` commands)
#   -> independent reviewer agent (structured verdict)  ->  commit + mark passing
#   any failure -> feedback to the next implementer attempt (max 3)  ->  else mark blocked and stop.
# The agents never decide that they are done; the gate and the reviewer do.
#
# Usage: scripts/harness.sh [--only F0x] [--max-attempts 3]
set -uo pipefail
cd "$(dirname "$0")/.."

ONLY=""; MAX=3
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2;;
    --max-attempts) MAX="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 64;;
  esac
done

LOGS=harness/logs; mkdir -p "$LOGS"
RUNLOG=harness/runs.md
# Comma-separated and always quoted: unquoted, the shell split "Bash(pnpm *)" and globbed the `*`, so the first run's
# agents could not run a single test (found in the logs: permission_denials).
IMPL_TOOLS='Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Bash(pnpm:*),Bash(npx:*),Bash(node:*),Bash(ffmpeg:*),Bash(ffprobe:*),Bash(ls:*),Bash(mkdir:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(wc:*),Bash(head:*),Bash(tail:*),Bash(grep:*),Bash(cat:*)'
REVIEW_TOOLS='Read,Glob,Grep,Bash(pnpm verify:*),Bash(pnpm test:*),Bash(npx vitest:*),Bash(npx tsc:*),Bash(npx tsx:*),Bash(git diff:*),Bash(git status:*),Bash(git log:*),Bash(ls:*),Bash(grep:*),Bash(cat:*)'
VERDICT_SCHEMA='{"type":"object","properties":{"pass":{"type":"boolean"},"issues":{"type":"array","items":{"type":"string"}},"nits":{"type":"array","items":{"type":"string"}}},"required":["pass","issues"]}'

feature_field() { node -e 'const f=require("./specs/features.json").features.find(x=>x.id===process.argv[1]);const v=f[process.argv[2]];console.log(Array.isArray(v)?v.join("\n"):v)' "$1" "$2"; }
set_status() { node -e '
  const fs=require("fs");const p="specs/features.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));
  const f=j.features.find(x=>x.id===process.argv[1]);f.status=process.argv[2];
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$1" "$2"; }
next_features() { node -e '
  const j=require("./specs/features.json");const only=process.argv[1];
  for(const f of j.features) if(f.status!=="passing" && (!only||f.id.startsWith(only))) console.log(f.id)' "$ONLY"; }
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$RUNLOG"; }

gate() { # external verification, independent of what the agent claims
  local id=$1 out
  local vout
  if ! vout=$(bash scripts/verify.sh 2>&1); then printf 'pnpm verify failed:\n%s\n' "$(echo "$vout" | tail -40)"; return 1; fi
  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    if ! out=$(bash -c "$cmd" 2>&1); then printf 'acceptance command failed: %s\n%s\n' "$cmd" "$(echo "$out" | tail -40)"; return 1; fi
  done < <(feature_field "$id" accept)
  printf 'pnpm verify: OK\n%s\nacceptance commands: OK\n' "$(echo "$vout" | tail -25)"
  return 0
}

for id in $(next_features); do
  spec=$(feature_field "$id" spec)
  feedback=""
  log "### $id start ($spec)"
  for attempt in $(seq 1 "$MAX"); do
    prompt="Implement the feature specified in $spec (feature id $id). Attempt $attempt of $MAX."
    [ -n "$feedback" ] && prompt="$prompt

The previous attempt was rejected. Fix exactly these problems (and keep everything else green):
$feedback"
    log "$id attempt $attempt: implementer"
    claude -p "$prompt" --agent implementer --permission-mode acceptEdits \
      --allowedTools "$IMPL_TOOLS" --output-format stream-json --verbose \
      > "$LOGS/$id-impl-$attempt.jsonl" 2> "$LOGS/$id-impl-$attempt.err"

    log "$id attempt $attempt: gate"
    gate_out=$(gate "$id"); gate_rc=$?
    printf '%s\n' "$gate_out" > "$LOGS/$id-gate-$attempt.txt"
    if [ $gate_rc -ne 0 ]; then
      feedback="$gate_out"; log "$id attempt $attempt: GATE FAIL"; continue
    fi

    log "$id attempt $attempt: reviewer"
    review=$(claude -p "Review feature $id against $spec. The implementer claims it is done. The automated gate (pnpm verify + acceptance commands) is green; its output is in $LOGS/$id-gate-$attempt.txt." \
      --agent reviewer --permission-mode default --allowedTools "$REVIEW_TOOLS" \
      --output-format json --json-schema "$VERDICT_SCHEMA" 2> "$LOGS/$id-review-$attempt.err")
    echo "$review" > "$LOGS/$id-review-$attempt.json"
    verdict=$(node -e '
      const r=JSON.parse(process.argv[1]);const v=r.structured_output??JSON.parse(r.result);
      console.log(v.pass?"PASS":"FAIL");for(const i of v.issues||[])console.log("- "+i)' "$review" 2>/dev/null || echo "FAIL
- reviewer output unreadable")
    if [ "$(echo "$verdict" | head -1)" = "PASS" ]; then
      set_status "$id" passing
      git add -A && git commit -q -m "feat($id): $(head -1 "$spec" | sed 's/^# //')

Built by the implementer agent, gated by pnpm verify + acceptance commands,
approved by the reviewer agent (attempt $attempt).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
      log "$id PASSED on attempt $attempt -> $(git rev-parse --short HEAD)"
      continue 2
    fi
    feedback=$(echo "$verdict" | tail -n +2)
    log "$id attempt $attempt: REVIEW FAIL"
    printf '%s\n' "$feedback" | sed 's/^/    /' >> "$RUNLOG"
  done
  set_status "$id" blocked
  log "$id BLOCKED after $MAX attempts — human needed. Last feedback:"
  printf '%s\n' "$feedback" | sed 's/^/    /' >> "$RUNLOG"
  exit 1
done
log "all requested features passing"
