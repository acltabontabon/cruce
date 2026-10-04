#!/usr/bin/env bash
# Mirror this repository (main + tags) into an Artifacts repository, e.g. to connect Workers Builds.
#   tools/mirror-to-artifacts.sh [repo] [namespace]        default: cruce-platform cruce
# Uses a 2-minute write token passed per command (never stored in git config or the remote URL).
set -euo pipefail
REPO="${1:-cruce-platform}"
NS="${2:-cruce}"
: "${CLOUDFLARE_ACCOUNT_ID:=YOUR_32_CHARACTER_ACCOUNT_ID}"; export CLOUDFLARE_ACCOUNT_ID
export GIT_TERMINAL_PROMPT=0
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=v.result??v;process.stdout.write(String(r[process.argv[1]]??""))})' "$1"; }

if ! cf artifacts namespaces repos get "$REPO" --namespace "$NS" >/dev/null 2>&1; then
	CREATED="$(cf artifacts namespaces repos create "$NS" --name "$REPO" --description "Cruce source (Workers Builds)" --default-branch main 2>/dev/null)"
	echo "created $NS/$REPO"
fi
REMOTE="https://${CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/${NS}/${REPO}.git"
TOKEN_JSON="$(cf artifacts namespaces tokens create "$NS" --repo "$REPO" --scope write --ttl 120 2>/dev/null)"
TOKEN="$(printf '%s' "$TOKEN_JSON" | field plaintext)"
TOKEN_ID="$(printf '%s' "$TOKEN_JSON" | field id)"
[ -n "$TOKEN" ] || { echo "could not mint a write token"; exit 1; }
git -c credential.helper= -c http.extraHeader="Authorization: Bearer $TOKEN" push --quiet "$REMOTE" "main:refs/heads/main" --force
echo "pushed $(git rev-parse --short main) to $NS/$REPO"
unset TOKEN
# Revoke every active token on the repo (including create()'s initial token). Token ids resolve through
# an eventually consistent index, so give it a moment and retry once.
sleep 2
for attempt in 1 2; do
	IDS="$(cf artifacts namespaces repos tokens list --namespace "$NS" --name "$REPO" --state active 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const r=v.result??v;const t=Array.isArray(r)?r:(r.tokens??[]);process.stdout.write(t.map(x=>x.id).join(" "))}catch{}})')"
	[ -z "$IDS" ] && break
	for id in $IDS; do cf artifacts namespaces tokens revoke "$id" --namespace "$NS" --force >/dev/null 2>&1 || true; done
	sleep 2
done
echo "active tokens remaining: $(cf artifacts namespaces repos tokens list --namespace "$NS" --name "$REPO" --state active 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const r=v.result??v;process.stdout.write(String((Array.isArray(r)?r:(r.tokens??[])).length))}catch{process.stdout.write("?")}})')"
echo "remote: $REMOTE"
