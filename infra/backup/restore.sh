#!/usr/bin/env bash
# Restores an encrypted backup into a database.
#   BACKUP_PASSPHRASE=... ./restore.sh backups/dineos-20261015T210000Z.dump.enc postgres://localhost:5432/dineos_restored
# The target database must exist and be empty. Roles dineos_app and dineos_admin are created if missing
# (without passwords: set them afterwards with ALTER ROLE ... PASSWORD).
set -euo pipefail

FILE="${1:?usage: restore.sh <file.dump.enc> <target-database-url>}"
TARGET="${2:?usage: restore.sh <file.dump.enc> <target-database-url>}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"

if [[ -f "${FILE%.dump.enc}.sha256" ]]; then
  expected="$(cut -d' ' -f1 < "${FILE%.dump.enc}.sha256")"
  actual="$( (sha256sum "$FILE" 2>/dev/null || shasum -a 256 "$FILE") | cut -d' ' -f1)"
  [[ "$expected" == "$actual" ]] || { echo "checksum mismatch: backup file is damaged"; exit 1; }
fi

psql "$TARGET" -v ON_ERROR_STOP=1 -q -c "
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'dineos_app') then create role dineos_app login nobypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'dineos_admin') then create role dineos_admin login bypassrls; end if;
  end \$\$;"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | pg_restore --no-owner --exit-on-error --dbname="$TARGET"

echo "restored $(basename "$FILE") into ${TARGET%%\?*}"
