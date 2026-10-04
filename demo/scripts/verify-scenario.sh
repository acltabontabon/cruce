#!/usr/bin/env bash
# Replays the demo scenario with plain git and Node's test runner, outside Cruce.
# Proves the scripted Flight work is real: every step commits, merges cleanly, and passes tests,
# and that F-021's final step depends on F-022's contract change (it fails on the old baseline).
set -euo pipefail
DEMO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME="Cruce Demo" GIT_AUTHOR_EMAIL="demo@cruce.acltabontabon.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

run_tests() { (cd "$1" && node --test "test/**/*.test.ts" >"$WORK/test.log" 2>&1) && echo "  tests: $(grep -E '^ℹ pass' "$WORK/test.log")" || { echo "  TESTS FAILED in $1"; tail -30 "$WORK/test.log"; return 1; }; }
apply() { cp -R "$DEMO/scenario/$2/." "$1/"; (cd "$1" && git add -A && git commit -qm "$3"); echo "  $(cd "$1" && git log --oneline -1)"; }
land() { (cd "$WORK/canonical" && git fetch -q "$WORK/$1" main && git merge -q --no-ff -m "Land $1" FETCH_HEAD) && echo "  canonical: $(cd "$WORK/canonical" && git log --oneline -1)"; }

echo "baseline"
git init -q -b main "$WORK/canonical"
cp -R "$DEMO/auth-service/." "$WORK/canonical/"
(cd "$WORK/canonical" && git add -A && git commit -qm "Baseline")
run_tests "$WORK/canonical"
for f in F-021 F-022 F-023; do git clone -q "$WORK/canonical" "$WORK/$f"; done

echo "F-023 session cleanup"; apply "$WORK/F-023" f023-session-cleanup "Add idle session cleanup"; run_tests "$WORK/F-023"
echo "F-022 JWT migration";  apply "$WORK/F-022" f022-jwt-migration "Migrate to typed JWT verification"; run_tests "$WORK/F-022"
echo "F-021 step 1 (partial clearance)"; apply "$WORK/F-021" f021-rotation-1 "Add refresh token families and rotation storage"; run_tests "$WORK/F-021"

echo "F-021 step 2 on the OLD baseline must fail (it depends on F-022's contract)"
cp -R "$WORK/F-021" "$WORK/F-021-unsequenced"
cp -R "$DEMO/scenario/f021-rotation-2/." "$WORK/F-021-unsequenced/"
if (cd "$WORK/F-021-unsequenced" && node --test "test/**/*.test.ts" >/dev/null 2>&1); then echo "  UNEXPECTED: passed without F-022"; exit 1; else echo "  failed as expected"; fi

echo "land F-022"; land F-022; run_tests "$WORK/canonical"
echo "land F-023"; land F-023; run_tests "$WORK/canonical"
echo "refresh F-021 onto canonical"
(cd "$WORK/F-021" && git pull -q --no-rebase --no-edit "$WORK/canonical" main) && echo "  $(cd "$WORK/F-021" && git log --oneline -1)"
run_tests "$WORK/F-021"
echo "F-021 step 2 (re-planned)"; apply "$WORK/F-021" f021-rotation-2 "Rotate refresh tokens on use"; run_tests "$WORK/F-021"
echo "land F-021"; land F-021; run_tests "$WORK/canonical"
echo
(cd "$WORK/canonical" && git log --graph --oneline --all | head -20)
echo "SCENARIO VERIFIED"
