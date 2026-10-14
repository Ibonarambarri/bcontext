#!/usr/bin/env sh
# Everything a change to the web app has to pass: typecheck, tests, the
# production build and the bundle budgets. CI runs exactly this
# (.github/workflows/ci.yml); `npm run verify -w bcontext-web` locally.
#
#   VERIFY_QUICK=1 scripts/verify.sh   skip `next build` while iterating
set -eu
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
started=$(date +%s)
log=$(mktemp -t bcontext-web-verify.XXXXXX)

# No pipes around the commands that decide: in sh a pipeline's status is the
# last command's. Each step writes to a log, shown only when it fails.
run() {
  name=$1; shift
  step "$name"
  if "$@" > "$log" 2>&1; then
    tail -n "${SHOW:-2}" "$log"
  else
    tail -n 60 "$log"
    printf '\n\033[31m%s failed\033[0m\n' "$name" >&2
    exit 1
  fi
}

run "typecheck"     npm run -s typecheck
SHOW=6 run "test"   npm run -s test -- --reporter=dot
if [ "${VERIFY_QUICK:-}" = "1" ]; then
  printf '\n(VERIFY_QUICK: next build skipped — run the full verify before the PR)\n'
else
  SHOW=1 run "build (next)" npm run -s build
  SHOW=4 run "perf:budget"  npm run -s perf:budget
fi

printf '\n\033[32mverify ok\033[0m in %ss\n' "$(( $(date +%s) - started ))"
