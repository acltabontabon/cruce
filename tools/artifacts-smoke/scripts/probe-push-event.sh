#!/usr/bin/env bash
# Pushes one empty commit to a repo with a 2-minute write token (revoked right after),
# so that a `cf.artifacts.repo.pushed` event can be observed on the subscribed queue.
set -euo pipefail
BASE="${SMOKE_URL:-http://localhost:8790}"
REPO="${1:-cruce-bootstrap}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_TERMINAL_PROMPT=0

TOKEN_JSON="$(curl -sS -X POST "$BASE/repos/$REPO/tokens" -H 'content-type: application/json' -d '{"scope":"write","ttl":120}')"
TOKEN="$(printf '%s' "$TOKEN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).plaintext))')"
TOKEN_ID="$(printf '%s' "$TOKEN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
REMOTE="$(curl -sS "$BASE/repos/$REPO/info" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).remote))')"

git -c credential.helper= -c http.extraHeader="Authorization: Bearer $TOKEN" clone -q --depth 1 "$REMOTE" "$WORK/r"
cd "$WORK/r"
git -c user.name="Cruce Probe" -c user.email=probe@cruce.acltabontabon.com commit -q --allow-empty -m "Event delivery probe $(date -u +%H:%M:%S)"
git -c credential.helper= -c http.extraHeader="Authorization: Bearer $TOKEN" push -q "$REMOTE" HEAD:refs/heads/main
echo "pushed $(git rev-parse HEAD)"
curl -sS -X POST "$BASE/repos/$REPO/revoke" -H 'content-type: application/json' -d "{\"id\":\"$TOKEN_ID\"}" >/dev/null
echo "token revoked"
