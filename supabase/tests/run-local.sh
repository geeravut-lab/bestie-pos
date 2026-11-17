#!/usr/bin/env bash
# Run migrations + RLS tests on a throw-away local Postgres (needs postgres 14+ binaries; run as a non-root user,
# or as root — the script then drops to the `postgres` OS user).
#   supabase/tests/run-local.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
chmod 755 "$WORK" "$HERE" "$HERE/../migrations" 2>/dev/null || true
if [ "$(id -u)" = 0 ]; then
  chown postgres "$WORK"
  RUN=(su postgres -c)
else
  RUN=(bash -c)
fi
run() { "${RUN[@]}" "$1"; }
PORT=54999
run "$PGBIN/initdb -D $WORK/data -U postgres --auth=trust >/dev/null"
run "$PGBIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK' -l $WORK/log -w start >/dev/null"
trap 'run "$PGBIN/pg_ctl -D $WORK/data -m immediate stop >/dev/null" || true; rm -rf "$WORK"' EXIT
PSQL="psql -h $WORK -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
run "$PSQL -d postgres -c 'create database bestie' >/dev/null"
run "$PSQL -d bestie -f $HERE/local_stub.sql"
for f in "$HERE"/../migrations/*.sql; do
  echo "apply $(basename "$f")"
  run "$PSQL -d bestie -f $f"
done
for t in "$HERE"/*.test.sql; do
  out="$(run "$PSQL -d bestie -f $t" 2>&1)" || { echo "$out"; echo "DB TESTS FAILED: $(basename "$t")"; exit 1; }
  echo "$out" | grep -E "PASS|ALL" | sed -E 's/^psql:[^ ]+ NOTICE:  //'
done
