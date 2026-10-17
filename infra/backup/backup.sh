#!/usr/bin/env bash
# Nightly encrypted backup (spec §12): pg_dump -> AES-256 -> local dir -> a second location you own.
#
# Required:
#   DATABASE_OWNER_URL     postgres://... (superuser or owner; dumps every tenant)
#   BACKUP_PASSPHRASE      long random secret; store it OUTSIDE the server (password manager)
# Optional:
#   BACKUP_DIR             default ./backups
#   BACKUP_KEEP_DAYS       default 14 (local copies)
#   BACKUP_RSYNC_TARGET    e.g. backup@vault.example.in:/srv/mezmitra  (copied with rsync over ssh)
#   BACKUP_S3_URI          e.g. s3://mezmitra-backups/prod              (aws cli; set AWS_ENDPOINT_URL for MinIO)
#
# Cron (02:30 IST):  30 2 * * *  /opt/mezmitra/infra/backup/backup.sh >> /var/log/mezmitra-backup.log 2>&1
set -euo pipefail

: "${DATABASE_OWNER_URL:?set DATABASE_OWNER_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="mezmitra-${STAMP}"
mkdir -p "$BACKUP_DIR"
umask 077

echo "[$(date -u +%FT%TZ)] backup ${NAME} starting"

# Row counts per table, so a restore can be checked against what was dumped.
psql "$DATABASE_OWNER_URL" -At -c "
  select json_object_agg(relname, n) from (
    select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I', c.relname), false, true, '')))[1]::text::bigint as n
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r'
  ) t" > "${BACKUP_DIR}/${NAME}.manifest.json"

pg_dump --format=custom --compress=9 --no-password "$DATABASE_OWNER_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE \
  > "${BACKUP_DIR}/${NAME}.dump.enc"

sha256sum "${BACKUP_DIR}/${NAME}.dump.enc" 2>/dev/null > "${BACKUP_DIR}/${NAME}.sha256" \
  || shasum -a 256 "${BACKUP_DIR}/${NAME}.dump.enc" > "${BACKUP_DIR}/${NAME}.sha256"
# Signed with a key derived from the passphrase: restore.sh refuses a backup whose signature does
# not match, so a changed file (or a swapped one with a fresh checksum beside it) is caught.
"$(dirname "$0")/backup-mac.sh" "${BACKUP_DIR}/${NAME}.dump.enc" > "${BACKUP_DIR}/${NAME}.hmac"

SIZE="$(du -h "${BACKUP_DIR}/${NAME}.dump.enc" | cut -f1)"
echo "[$(date -u +%FT%TZ)] wrote ${NAME}.dump.enc (${SIZE})"

if [[ -n "${BACKUP_RSYNC_TARGET:-}" ]]; then
  rsync -a "${BACKUP_DIR}/${NAME}".* "${BACKUP_RSYNC_TARGET}/"
  echo "copied to ${BACKUP_RSYNC_TARGET}"
fi
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  for f in "${BACKUP_DIR}/${NAME}".*; do aws s3 cp --only-show-errors "$f" "${BACKUP_S3_URI}/"; done
  echo "copied to ${BACKUP_S3_URI}"
fi
if [[ -z "${BACKUP_RSYNC_TARGET:-}${BACKUP_S3_URI:-}" ]]; then
  echo "WARNING: no second location configured (BACKUP_RSYNC_TARGET or BACKUP_S3_URI). A backup on the same server is not a backup."
fi

# Backups from before the rename are named dineos-*; they age out the same way.
find "$BACKUP_DIR" \( -name 'mezmitra-*' -o -name 'dineos-*' \) -type f -mtime "+${KEEP_DAYS}" -delete
echo "[$(date -u +%FT%TZ)] backup ${NAME} done"
