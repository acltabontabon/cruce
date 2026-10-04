#!/usr/bin/env bash
# End-to-end Artifacts verification through the local smoke Worker (`pnpm dev` in tools/artifacts-smoke).
#
#   create repo (binding) → commit README → push with standard git (write token in a transient header)
#   → clone into a separate directory with a READ token → verify README / SHA / fetch / log
#   → verify the read token cannot push → push + fetch git notes → inspect via binding → revoke tokens
#
# Tokens live only in shell variables. They are passed with `git -c http.extraHeader=...` per command,
# never written to a remote URL, git config, or stdout.
set -euo pipefail

BASE="${SMOKE_URL:-http://localhost:8790}"
REPO="${1:-cruce-bootstrap}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export GIT_TERMINAL_PROMPT=0

jqr() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const p=process.argv[1].split(".");let o=v;for(const k of p){o=o?.[k]}process.stdout.write(o==null?"":String(o))})' "$1"; }
post() { curl -sS -X POST "$BASE$1" -H 'content-type: application/json' -d "${2:-{\}}"; }
get() { curl -sS "$BASE$1"; }
step() { printf '\n== %s\n' "$*"; }
git_auth() { local token="$1"; shift; git -c credential.helper= -c http.extraHeader="Authorization: Bearer $token" "$@"; }

step "create repo '$REPO' through the Workers binding"
CREATED="$(post /repos "{\"name\":\"$REPO\",\"description\":\"Cruce bootstrap verification repo\"}")"
REMOTE="$(printf '%s' "$CREATED" | jqr remote)"
WRITE_TOKEN="$(printf '%s' "$CREATED" | jqr token)"
if [ -z "$REMOTE" ] || [ -z "$WRITE_TOKEN" ]; then echo "create failed: $(printf '%s' "$CREATED" | jqr error)"; exit 1; fi
echo "name:   $(printf '%s' "$CREATED" | jqr name)"
echo "remote: $REMOTE"
echo "token:  <redacted, expires $(printf '%s' "$WRITE_TOKEN" | sed -n 's/.*expires=//p')>"

step "commit README and push with a standard git client"
git init -q -b main "$WORK/src"
cd "$WORK/src"
git config user.name "Cruce Bootstrap"
git config user.email "bootstrap@cruce.acltabontabon.com"
printf '# Cruce bootstrap\n\nVerifies Artifacts create, push, clone and fetch.\n' > README.md
git add README.md
git commit -q -m "Initial commit"
PUSHED_SHA="$(git rev-parse HEAD)"
git_auth "$WRITE_TOKEN" push -q "$REMOTE" HEAD:refs/heads/main
echo "pushed $PUSHED_SHA"
if git config --get-regexp 'remote\..*|http\..*' >/dev/null 2>&1; then echo "FAIL: credentials or remotes persisted in git config"; exit 1; fi
echo "git config holds no remote or auth header"

step "mint a READ token and clone into a separate directory"
READ_JSON="$(post "/repos/$REPO/tokens" '{"scope":"read","ttl":600}')"
READ_TOKEN="$(printf '%s' "$READ_JSON" | jqr plaintext)"
READ_ID="$(printf '%s' "$READ_JSON" | jqr id)"
echo "read token id $READ_ID scope $(printf '%s' "$READ_JSON" | jqr scope)"
git_auth "$READ_TOKEN" clone -q "$REMOTE" "$WORK/clone"
cd "$WORK/clone"
CLONED_SHA="$(git rev-parse HEAD)"
test -f README.md && echo "README present: $(head -1 README.md)"
[ "$CLONED_SHA" = "$PUSHED_SHA" ] && echo "SHA matches: $CLONED_SHA" || { echo "FAIL: sha mismatch $CLONED_SHA"; exit 1; }
git log --oneline
if git remote get-url origin | grep -q 'art_v1'; then echo "FAIL: token in remote url"; exit 1; fi

step "push a second commit + git note from the source, fetch it from the clone"
cd "$WORK/src"
printf '\nSecond line.\n' >> README.md
git commit -q -am "Second commit"
git notes --ref=cruce add -m '{"flightId":"F-000","intent":"bootstrap verification"}' HEAD
git_auth "$WRITE_TOKEN" push -q "$REMOTE" HEAD:refs/heads/main 'refs/notes/cruce:refs/notes/cruce'
SECOND_SHA="$(git rev-parse HEAD)"
cd "$WORK/clone"
git_auth "$READ_TOKEN" fetch -q "$REMOTE" 'refs/heads/main:refs/remotes/origin/main' 'refs/notes/cruce:refs/notes/cruce'
[ "$(git rev-parse origin/main)" = "$SECOND_SHA" ] && echo "fetch OK: origin/main = $SECOND_SHA"
echo "note: $(git notes --ref=cruce show "$SECOND_SHA")"
git log --oneline origin/main

step "read token must not be able to push"
cd "$WORK/clone"
git checkout -q -b probe origin/main
git commit -q --allow-empty -m "should be rejected"
if git_auth "$READ_TOKEN" push -q "$REMOTE" HEAD:refs/heads/probe 2>/dev/null; then echo "FAIL: read token pushed"; exit 1; else echo "push with read token rejected (expected)"; fi

step "inspect through the binding"
echo "info: $(get "/repos/$REPO/info" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(JSON.stringify({id:v.id,defaultBranch:v.defaultBranch,lastPushAt:v.lastPushAt,source:v.source}))})')"
echo "log:  $(get "/repos/$REPO/log" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).map(c=>c.hash.slice(0,8)+" "+c.message).join(" | "))})')"
echo "file: $(get "/repos/$REPO/file?path=README.md" | jqr type)"

step "revoke tokens"
echo "read revoked:  $(post "/repos/$REPO/revoke" "{\"id\":\"$READ_ID\"}" | jqr revoked)"
echo "write revoked: $(post "/repos/$REPO/revoke" "{\"id\":\"$WRITE_TOKEN\"}" | jqr revoked)"
if git_auth "$READ_TOKEN" fetch -q "$REMOTE" 2>/dev/null; then echo "WARN: revoked read token still fetches"; else echo "revoked read token rejected"; fi

unset WRITE_TOKEN READ_TOKEN
step "ARTIFACTS VERIFIED"
