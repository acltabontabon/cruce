#!/usr/bin/env bash
# Independently verify what Cruce did, using only `cf` and a standard git client:
#   mint a 2-minute READ token → clone the repo → show history + Cruce notes → run its tests → revoke.
#
#   tools/verify-repo.sh [repo] [namespace]      default: auth-service cruce-dev
set -euo pipefail
REPO="${1:-auth-service}"
NS="${2:-cruce-dev}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_TERMINAL_PROMPT=0
: "${CLOUDFLARE_ACCOUNT_ID:=YOUR_32_CHARACTER_ACCOUNT_ID}"; export CLOUDFLARE_ACCOUNT_ID

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=v.result??v;process.stdout.write(String(r[process.argv[1]]??""))})' "$1"; }

TOKEN_JSON="$(cf artifacts namespaces tokens create "$NS" --repo "$REPO" --scope read --ttl 120 2>/dev/null)"
TOKEN="$(printf '%s' "$TOKEN_JSON" | field plaintext)"
[ -n "$TOKEN" ] || TOKEN="$(printf '%s' "$TOKEN_JSON" | field token)"
TOKEN_ID="$(printf '%s' "$TOKEN_JSON" | field id)"
REMOTE="https://${CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/${NS}/${REPO}.git"
[ -n "$TOKEN" ] || { echo "could not mint a read token"; exit 1; }

git -c credential.helper= -c http.extraHeader="Authorization: Bearer $TOKEN" clone -q "$REMOTE" "$WORK/repo"
cd "$WORK/repo"
git -c credential.helper= -c http.extraHeader="Authorization: Bearer $TOKEN" fetch -q origin 'refs/notes/cruce:refs/notes/cruce' 2>/dev/null || echo "(no Cruce notes on this repo)"

echo "== $NS/$REPO  ($REMOTE)"
git log --graph --format='%h %s  (%an)' -n 20
echo
echo "== Cruce notes on the latest landings"
for c in $(git log --format=%H -n 20 --merges); do
	if git notes --ref=cruce show "$c" >/dev/null 2>&1; then
		echo "-- $(git log -1 --format='%h %s' "$c")"
		git notes --ref=cruce show "$c" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s);console.log(JSON.stringify({flightId:n.flightId,planVersion:n.planVersion,amendments:(n.planAmendments||[]).map(a=>a.reason),congestion:(n.congestion||[]).map(c=>c.label),validation:n.validation?.summary,preflight:n.preflight}))})'
	fi
done
if [ -f package.json ] && grep -q '"test"' package.json; then
	echo
	echo "== tests on the cloned repository"
	node --test "test/**/*.test.ts" 2>&1 | grep -E "^ℹ (tests|pass|fail)"
fi
if [ -n "$TOKEN_ID" ]; then cf artifacts namespaces tokens revoke "$NS" --body "{\"id\":\"$TOKEN_ID\",\"repo\":\"$REPO\"}" >/dev/null 2>&1 || true; fi
unset TOKEN
