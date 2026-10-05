#!/usr/bin/env bash
# Independently checks reusable source overlays with ordinary Git.
# Historical fixture directory names are preserved; they are not Cruce domain records.
set -euo pipefail
DEMO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME="Cruce Demo" GIT_AUTHOR_EMAIL="demo@cruce.acltabontabon.com"
export GIT_AUTHOR_DATE="2026-10-05T00:00:00Z" GIT_COMMITTER_DATE="2026-10-05T00:00:00Z"
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

run_tests() { (cd "$1" && node --test "test/**/*.test.ts" >"$WORK/test.log" 2>&1) && echo "  tests: $(grep -E '^ℹ pass' "$WORK/test.log")" || { echo "  TESTS FAILED in $1"; tail -30 "$WORK/test.log"; return 1; }; }
apply() { cp -R "$DEMO/scenario/$2/." "$1/"; (cd "$1" && git add -A && git commit -qm "$3"); echo "  $(cd "$1" && git log --oneline -1)"; }
land() { (cd "$WORK/canonical" && git fetch -q "$WORK/$1" main && git merge -q --no-ff -m "Land $1" FETCH_HEAD) && echo "  canonical: $(cd "$WORK/canonical" && git log --oneline -1)"; }

echo "baseline"
git init -q -b main "$WORK/canonical"
cp -R "$DEMO/auth-service/." "$WORK/canonical/"
(cd "$WORK/canonical" && git add -A && git commit -qm "Baseline")
run_tests "$WORK/canonical"
for f in rotation jwt cleanup; do git clone -q "$WORK/canonical" "$WORK/$f"; done

echo "cleanup session cleanup"; apply "$WORK/cleanup" f023-session-cleanup "Add idle session cleanup"; run_tests "$WORK/cleanup"
echo "jwt JWT migration";  apply "$WORK/jwt" f022-jwt-migration "Migrate to typed JWT verification"; run_tests "$WORK/jwt"
echo "rotation step 1 (independent work)"; apply "$WORK/rotation" f021-rotation-1 "Add refresh token families and rotation storage"; run_tests "$WORK/rotation"

echo "rotation step 2 on the OLD baseline must fail (it depends on jwt's contract)"
cp -R "$WORK/rotation" "$WORK/rotation-unsequenced"
cp -R "$DEMO/scenario/f021-rotation-2/." "$WORK/rotation-unsequenced/"
if (cd "$WORK/rotation-unsequenced" && node --test "test/**/*.test.ts" >/dev/null 2>&1); then echo "  UNEXPECTED: passed without jwt"; exit 1; else echo "  failed as expected"; fi

echo "land jwt"; land jwt; run_tests "$WORK/canonical"
echo "land cleanup"; land cleanup; run_tests "$WORK/canonical"
echo "refresh rotation onto canonical"
(cd "$WORK/rotation" && git fetch -q "$WORK/canonical" main && git merge -q --no-edit -m "Integrate accepted source" FETCH_HEAD) && echo "  $(cd "$WORK/rotation" && git log --oneline -1)"
run_tests "$WORK/rotation"
echo "rotation step 2 (after integration)"; apply "$WORK/rotation" f021-rotation-2 "Rotate refresh tokens on use"; run_tests "$WORK/rotation"
echo "land rotation"; land rotation; run_tests "$WORK/canonical"
echo
(cd "$WORK/canonical" && git log --graph --oneline --all | head -20)
echo "SCENARIO VERIFIED"
