#!/usr/bin/env bash
# Restores an encrypted backup into a database.
#   BACKUP_PASSPHRASE=... ./restore.sh backups/dineos-20261015T210000Z.dump.enc postgres://localhost:5432/dineos_restored
# The target database must exist and be empty. Roles dineos_app and dineos_admin are created if missing
# (without passwords: set them afterwards with ALTER ROLE ... PASSWORD).
set -euo pipefail

FILE="${1:?usage: restore.sh <file.dump.enc> <target-database-url>}"
TARGET="${2:?usage: restore.sh <file.dump.enc> <target-database-url>}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"

# Never restore a file that cannot be checked. Backups carry a signature (.hmac) made with the
# passphrase; ones made before signing have only a checksum (.sha256), which shows damage but not
# tampering, so they are restored only with ALLOW_UNSIGNED_BACKUP=yes.
HMAC_FILE="${FILE%.dump.enc}.hmac"
SHA_FILE="${FILE%.dump.enc}.sha256"
if [[ -f "$HMAC_FILE" ]]; then
  expected="$(tr -d '[:space:]' < "$HMAC_FILE")"
  actual="$("$(dirname "$0")/backup-mac.sh" "$FILE")"
  [[ "$expected" == "$actual" ]] || { echo "signature mismatch: the backup was changed, or made with a different passphrase"; exit 1; }
elif [[ -f "$SHA_FILE" && "${ALLOW_UNSIGNED_BACKUP:-}" == "yes" ]]; then
  expected="$(cut -d' ' -f1 < "$SHA_FILE")"
  actual="$( (sha256sum "$FILE" 2>/dev/null || shasum -a 256 "$FILE") | cut -d' ' -f1)"
  [[ "$expected" == "$actual" ]] || { echo "checksum mismatch: backup file is damaged"; exit 1; }
  echo "warning: unsigned backup, checked for damage only"
else
  echo "refusing to restore: no signature ($(basename "$HMAC_FILE")) next to the backup."
  echo "For a backup made before signing, set ALLOW_UNSIGNED_BACKUP=yes (its .sha256 must be present)."
  exit 1
fi

psql "$TARGET" -v ON_ERROR_STOP=1 -q -c "
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'dineos_app') then create role dineos_app login nobypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'dineos_admin') then create role dineos_admin login bypassrls; end if;
  end \$\$;"

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" \
  | pg_restore --no-owner --exit-on-error --dbname="$TARGET"

echo "restored $(basename "$FILE") into ${TARGET%%\?*}"
