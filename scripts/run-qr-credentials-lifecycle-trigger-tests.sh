#!/usr/bin/env bash
# scripts/run-qr-credentials-lifecycle-trigger-tests.sh
#
# Failure-safe local runner for
# tests/attendance/qr-credentials-lifecycle-trigger.test.ts.
#
# Invocation:
#   npm run test:qr-trigger
# or directly:
#   bash scripts/run-qr-credentials-lifecycle-trigger-tests.sh
#
# Prerequisite: `npm ci` must have already been run at least once (this
# script deliberately does NOT install dependencies itself — see the
# node_modules check below and the `npx --no-install` note near the
# Vitest invocation).
#
# Strictly local. This script does not accept a remote-CI override — an
# isolated CI runner that provisions its own disposable Supabase instance
# should invoke Vitest directly against that instance's own local-looking
# URL (satisfying tests/attendance/disposable-database-guard.ts's local
# check), or via PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS=true +
# PHASE6_DISPOSABLE_PROJECT_REF=<ref> for the rare case that instance is
# not reachable at a loopback address, through its own CI workflow step —
# not through this script, which is intentionally single-purpose: run this
# suite against THIS machine's local `supabase start` stack, safely.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TEST_FILE="tests/attendance/qr-credentials-lifecycle-trigger.test.ts"
SETUP_SQL="tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql"
TEARDOWN_SQL="tests/attendance/qr-credentials-lifecycle-trigger.test-only-teardown.sql"
ENV_LOCAL=".env.local"

log() { echo "run-qr-credentials-lifecycle-trigger-tests.sh: $*" >&2; }

# --- Dependencies must already be installed ---
# `npx vitest` with no local node_modules can silently fetch and run some
# OTHER version of Vitest from the registry instead of the repo-pinned
# one. Failing fast here, and using `npx --no-install` below (which
# refuses to fetch anything and errors instead), makes that impossible.
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  log "node_modules is missing. Run 'npm ci' first (this script does not install dependencies itself)."
  exit 1
fi

# --- Load .env.local explicitly, BEFORE the local-database guard below ---
# vitest.config.ts loads .env.local into process.env, but only INSIDE the
# Vitest process — which starts after this script's own guard would need
# to have already run, and after the SQL setup step below. Relying on
# Vitest's later loading would mean this script's guard runs against an
# empty NEXT_PUBLIC_SUPABASE_URL unless the caller separately exported it
# by hand. This script instead sources .env.local itself, so the guard
# sees the real configured value.
if [ -f "$ENV_LOCAL" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_LOCAL"
  set +a
else
  log "$ENV_LOCAL not found. Create it with the LOCAL Supabase URL/service-role key (see 'supabase status' after 'supabase start') before running this script."
  exit 1
fi

# --- Local-database guard, using the value just loaded from .env.local ---
url="${NEXT_PUBLIC_SUPABASE_URL:-}"
case "$url" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*)
    ;;
  *)
    log "NEXT_PUBLIC_SUPABASE_URL (\"$url\", from $ENV_LOCAL) does not look like a local Supabase instance (expected an http(s)://127.0.0.1 or http(s)://localhost origin)."
    log "This suite performs permanent encryption-key-registry transitions and installs SECURITY DEFINER test-only helpers — refusing to run against a non-local URL."
    log "Run 'supabase start' and update $ENV_LOCAL with the LOCAL values from 'supabase status' first."
    log "This script is strictly local and has no remote override; an isolated CI runner should invoke Vitest directly through its own workflow, not through this script."
    exit 1
    ;;
esac
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  log "SUPABASE_SERVICE_ROLE_KEY is not set in $ENV_LOCAL. Set it to the LOCAL service-role key from 'supabase status' before running this script."
  exit 1
fi

# --- Confirm the local stack is actually running ---
# The documented workflow requires `supabase start` to have been run
# first; this script does not start it automatically (starting Docker
# containers as a side effect of a test-runner script is its own can of
# worms), but it must fail clearly rather than let
# `supabase db reset --local` fail with a confusing error if the stack
# isn't up.
if ! supabase status >/dev/null 2>&1; then
  log "'supabase status' failed — the local Supabase stack does not appear to be running. Run 'supabase start' first, then re-run this script."
  exit 1
fi

# --- Cleanup, guaranteed via trap, with its own tracked exit status ---
# CORRECTED this round: a prior version logged a warning when teardown or
# the final reset failed but still exited with Vitest's own exit code —
# meaning a passing test run with FAILED cleanup could still report
# success (exit 0), silently leaving the SECURITY DEFINER test-only
# functions installed. cleanup_failed is tracked independently and forces
# a nonzero final exit whenever teardown or the final reset fails,
# regardless of whether Vitest itself passed.
vitest_exit_code=1
cleanup_failed=0

cleanup() {
  log "running teardown (always runs, success or failure)..."
  if ! supabase db query --local -f "$TEARDOWN_SQL"; then
    log "WARNING — teardown query failed; the test-only helpers may still be installed. Run '$TEARDOWN_SQL' manually and re-run 'supabase db reset --local'."
    cleanup_failed=1
  fi
  if ! supabase db reset --local; then
    log "WARNING — final 'supabase db reset --local' failed. Re-run it manually before trusting the local database's state."
    cleanup_failed=1
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    log "cleanup failed — reporting failure regardless of the test outcome (Vitest exit code was $vitest_exit_code)."
    exit 1
  fi
  exit "$vitest_exit_code"
}
trap cleanup EXIT

log "resetting local database to current migrations..."
supabase db reset --local || { log "'supabase db reset --local' failed — aborting before any test-only schema is installed."; exit 1; }

log "applying test-only setup..."
supabase db query --local -f "$SETUP_SQL" || { log "test-only setup failed — aborting before Vitest runs."; exit 1; }

log "running Vitest (repo-installed version only — no implicit download)..."
# --no-install refuses to fetch a package that isn't already present in
# node_modules/.bin, rather than silently downloading some other version
# of Vitest — the node_modules check above should already guarantee this
# succeeds, but --no-install makes the guarantee explicit at the point of
# use too.
npx --no-install vitest run "$TEST_FILE"
vitest_exit_code=$?

# `trap cleanup EXIT` fires automatically here: runs teardown + final
# reset, forces a nonzero exit if either failed, otherwise exits with
# $vitest_exit_code. Nothing further to do.
