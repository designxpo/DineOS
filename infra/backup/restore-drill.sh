#!/usr/bin/env bash
# Monthly restore drill (spec §12, §14): restore the newest backup into a scratch database, verify
# it, then drop it. Exits non-zero if anything is off, so it can alert from cron.
#
#   DATABASE_OWNER_URL=postgres://... BACKUP_PASSPHRASE=... BACKUP_DIR=./backups ./restore-drill.sh
set -euo pipefail

: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$HERE/../../apps/api/migrations}"

LATEST="$(ls -1t "$BACKUP_DIR"/dineos-*.dump.enc 2>/dev/null | head -1 || true)"
[[ -n "$LATEST" ]] || { echo "FAIL: no backups in $BACKUP_DIR"; exit 1; }
MANIFEST="${LATEST%.dump.enc}.manifest.json"

DRILL_DB="dineos_restore_drill_$(date +%s)"
ADMIN_URL="$(echo "$DATABASE_OWNER_URL" | sed -E 's#/[^/?]+(\?|$)#/postgres\1#')"
DRILL_URL="$(echo "$DATABASE_OWNER_URL" | sed -E "s#/[^/?]+(\\?|\$)#/${DRILL_DB}\\1#")"

cleanup() { psql "$ADMIN_URL" -q -c "drop database if exists ${DRILL_DB} with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "drill: restoring $(basename "$LATEST") into ${DRILL_DB}"
started=$(date +%s)
psql "$ADMIN_URL" -q -c "create database ${DRILL_DB}"
"$HERE/restore.sh" "$LATEST" "$DRILL_URL" >/dev/null
echo "drill: restore took $(( $(date +%s) - started ))s"

fail=0
check() { # name, sql returning a single value, expected
  local got
  got="$(psql "$DRILL_URL" -At -c "$2")"
  if [[ "$got" == "$3" ]]; then echo "  ok    $1"; else echo "  FAIL  $1 (got '$got', expected '$3')"; fail=1; fi
}

expected_migrations="$(ls -1 "$MIGRATIONS_DIR"/*.sql | wc -l | tr -d ' ')"
check "all migrations present" "select count(*) from schema_migrations" "$expected_migrations"
check "row-level security on every tenant table" \
  "select count(*) from information_schema.columns c join pg_class p on p.relname = c.table_name and p.relkind = 'r'
   where c.table_schema = 'public' and c.column_name = 'tenant_id' and not (p.relrowsecurity and p.relforcerowsecurity)" "0"
check "invoice numbers gap-free per outlet and year" \
  "select count(*) from (select outlet_id, fy_code from bills where invoice_seq is not null group by 1, 2 having max(invoice_seq) <> count(*)) g" "0"
check "app role cannot bypass RLS" "select rolbypassrls from pg_roles where rolname = 'dineos_app'" "f"

if [[ -f "$MANIFEST" ]]; then
  while IFS='=' read -r table count; do
    check "row count ${table}" "select count(*) from ${table}" "$count"
  done < <(node -e "const m=require(process.argv[1]);for(const[k,v] of Object.entries(m))console.log(k+'='+v)" "$(cd "$(dirname "$MANIFEST")" && pwd)/$(basename "$MANIFEST")")
else
  echo "  warn  no manifest next to the backup; row counts not compared"
fi

if [[ $fail -eq 0 ]]; then echo "PASS: $(basename "$LATEST") restores cleanly"; else echo "FAIL: restore drill found problems"; exit 1; fi
