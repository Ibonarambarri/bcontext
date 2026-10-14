#!/bin/sh
# One-shot migration runner for the docker compose stack (service `migrate`).
#
# Applies, in filename order, every file in /migrations
# (apps/api/supabase/migrations) whose version is not yet recorded in
# supabase_migrations.schema_migrations — the same table the Supabase CLI
# keeps, with the same row shape (version = the numeric prefix, name = the
# rest), so an instance can later be driven by either tool.
#
# Idempotent: a second run finds nothing pending and exits 0. `api` and
# `worker` start only after this exits 0, so a failed migration keeps the
# product down rather than running it on a half-built schema.
#
# Must not break: migrations run as `postgres` (not the superuser) because
# that is the role every object of the schema has always been created by;
# Auth and Storage must have created their own schemas first (auth.users,
# storage.buckets are referenced by the migrations), which the compose file
# guarantees with `service_healthy` and this script double-checks.
set -eu

: "${PGHOST:=db}" "${PGPORT:=5432}" "${PGUSER:=postgres}" "${PGDATABASE:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
DIR=${MIGRATIONS_DIR:-/migrations}
PSQL="psql -X -q -v ON_ERROR_STOP=1"
# Notices ("… does not exist, skipping") are noise on a fresh database.
export PGOPTIONS="-c client_min_messages=warning"

# Out-of-band hotfixes whose filename sorts before a migration they depend
# on. In production they were applied after it; on a fresh database they must
# be too. `version=after` — apply `version` right after `after`.
# 0027b revokes EXECUTE on a function 0028 creates.
DEFERRED="0027b=0028"

echo "migrate: waiting for Postgres, Auth and Storage schemas"
i=0
until [ "$($PSQL -tAc "select (to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null)::text" 2>/dev/null)" = "true" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "migrate: auth/storage schemas never appeared (are the auth and storage services healthy?)" >&2
    exit 1
  fi
  sleep 2
done

$PSQL <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
SQL

applied=$($PSQL -tAc "select version from supabase_migrations.schema_migrations")
count=0
apply() { # file
  local f base v name record pair d
  f=$1
  base=$(basename "$f" .sql)
  v=${base%%_*}
  name=${base#*_}
  if ! printf '%s\n' "$applied" | grep -qx "$v"; then
    echo "migrate: applying $base"
    record="insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$name') on conflict (version) do nothing"
    if grep -qiE '^[[:space:]]*begin[[:space:]]*;' "$f"; then
      # The file owns its transaction; record it once it has committed.
      $PSQL -o /dev/null -f "$f"
      $PSQL -c "$record"
    else
      # No transaction of its own: wrap file and record in one, so a failure
      # leaves neither behind and the next run retries cleanly.
      $PSQL -o /dev/null -1 -f "$f" -c "$record"
    fi
    count=$((count + 1))
  fi
  # Whatever was deferred until this version goes next.
  for pair in $DEFERRED; do
    if [ "${pair#*=}" = "$v" ]; then
      for d in "$DIR/${pair%%=*}"_*.sql; do [ -e "$d" ] && apply "$d"; done
    fi
  done
}

for f in "$DIR"/*.sql; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .sql)
  skip=0
  for pair in $DEFERRED; do [ "${base%%_*}" = "${pair%%=*}" ] && skip=1; done
  [ "$skip" = 1 ] || apply "$f"
done

echo "migrate: $count applied, $(printf '%s\n' "$applied" | grep -c . || true) already recorded"
