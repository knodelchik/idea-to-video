#!/usr/bin/env bash
# PreToolUse(Bash): agents never spend money or touch secrets. Live runs are for humans only.
cmd=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tool_input.command||"")}catch{console.log("")}})')
deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}
case "$cmd" in
  *--live*|*LIVE=1*) deny "Live generation spends real money. Only a human runs --live. Use --mock.";;
esac
if printf '%s' "$cmd" | grep -qE '(^|[^.a-zA-Z])\.env([^.a-zA-Z]|$)|\.env\.local'; then
  printf '%s' "$cmd" | grep -q '\.env\.example' || deny "Do not read or print .env (secrets). Use .env.example for key names."
fi
if printf '%s' "$cmd" | grep -qE '(fal\.run|queue\.fal\.run|api\.elevenlabs\.io|api\.groq\.com|generativelanguage\.googleapis\.com)'; then
  deny "Direct calls to paid APIs are not allowed for agents. Go through providers with --mock."
fi
if printf '%s' "$cmd" | grep -qE 'git (push|reset --hard|clean -f)|rm -rf (/|~|\.\.)'; then
  deny "Destructive or outward git/file commands are reserved for the human."
fi
exit 0
