#!/usr/bin/env bash
# Re-apply every Supabase migration + seed against $SUPABASE_DB_URL with psql
# (`npm run db:reset`). For a throwaway local Postgres only — it replays the
# files in order without tracking versions, so never point it at production
# (that is `deploy/migrate/migrate.sh`, which records versions). When the env var is missing we are in demo
# (in-memory) mode and there is nothing to reset.
set -euo pipefail

MIG_DIR="supabase/migrations"
SEED_FILE="supabase/seed.sql"

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "[db:reset] demo mode — nothing to reset (set SUPABASE_DB_URL to use Postgres)"
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[db:reset] psql not found in PATH" >&2
  exit 1
fi

if [[ ! -d "${MIG_DIR}" ]]; then
  echo "[db:reset] ${MIG_DIR} not found" >&2
  exit 1
fi

shopt -s nullglob
MIGS=("${MIG_DIR}"/*.sql)
shopt -u nullglob

if [[ "${#MIGS[@]}" -eq 0 ]]; then
  echo "[db:reset] no migrations found in ${MIG_DIR}" >&2
  exit 1
fi

for f in "${MIGS[@]}"; do
  echo "[db:reset] applying ${f}"
  psql "${SUPABASE_DB_URL}" -v ON_ERROR_STOP=1 -f "${f}"
done

if [[ -f "${SEED_FILE}" ]]; then
  echo "[db:reset] seeding ${SEED_FILE}"
  psql "${SUPABASE_DB_URL}" -v ON_ERROR_STOP=1 -f "${SEED_FILE}"
fi

echo "[db:reset] done"
