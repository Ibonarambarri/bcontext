#!/usr/bin/env sh
# Everything a change has to pass before it is merged: contract build,
# typecheck, tests and the three bundles. CI runs exactly this
# (.github/workflows/ci.yml); `npm run verify` runs it locally.
set -eu
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
started=$(date +%s)
log=$(mktemp -t bcontext-verify.XXXXXX)

# No pipes around the commands that decide: in sh a pipeline's status is the
# last command's, so `npm test | tail` would report a red suite as green.
# Each step writes to a log and the log is shown only when the step fails.
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

run "build:contract" npm run -s build:contract
run "typecheck"     npm run -s typecheck
SHOW=6 run "test"   npm run -s test -- --reporter=dot
run "build:worker"  npm run -s build:worker
run "build:api"     npm run -s build:api
# The collector ships in the same image and carries the same next-free rule;
# a bundle that only breaks on the third resource is one nobody notices here.
run "build:errors"  npm run -s build:errors

printf '\n\033[32mverify ok\033[0m in %ss\n' "$(( $(date +%s) - started ))"
