#!/usr/bin/env bash
# scripts/run-qr-issuance-reservation-tests.sh
#
# Failure-safe local runner for
# tests/attendance/qr-issuance-reservation.test.ts.
#
# Invocation:
#   npm run test:qr-issuance-reservation
# or directly:
#   bash scripts/run-qr-issuance-reservation-tests.sh
#
# Prerequisite: `npm ci` must have already been run at least once (this
# script deliberately does NOT install dependencies itself).
#
# Strictly local. No remote-CI override — an isolated CI runner that
# provisions its own disposable Supabase instance should invoke Vitest
# directly through its own workflow step, not through this script.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TEST_FILE="tests/attendance/qr-issuance-reservation.test.ts"
SETUP_SQL="tests/attendance/qr-issuance-reservation.test-only-setup.sql"
TEARDOWN_SQL="tests/attendance/qr-issuance-reservation.test-only-teardown.sql"
ENV_LOCAL=".env.local"

log() { echo "run-qr-issuance-reservation-tests.sh: $*" >&2; }

# --- Dependencies must already be installed ---
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  log "node_modules is missing. Run 'npm ci' first (this script does not install dependencies itself)."
  exit 1
fi

# --- Load .env.local explicitly, BEFORE the local-database guard below ---
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
    log "This suite installs SECURITY DEFINER test-only helpers (including lock-holding/pg_sleep infrastructure) — refusing to run against a non-local URL."
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
if ! supabase status >/dev/null 2>&1; then
  log "'supabase status' failed — the local Supabase stack does not appear to be running. Run 'supabase start' first, then re-run this script."
  exit 1
fi

# --- Cleanup, guaranteed via trap, with its own tracked exit status ---
# cleanup_failed is tracked independently and forces a nonzero final exit
# whenever teardown or the final reset fails, regardless of whether Vitest
# itself passed — a passing test run with FAILED cleanup must never report
# success, since it would silently leave the SECURITY DEFINER test-only
# functions (including pg_sleep-based lock holders) installed.
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
npx --no-install vitest run "$TEST_FILE"
vitest_exit_code=$?

# `trap cleanup EXIT` fires automatically here: runs teardown + final
# reset, forces a nonzero exit if either failed, otherwise exits with
# $vitest_exit_code. Nothing further to do.
