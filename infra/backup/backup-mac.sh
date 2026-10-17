#!/usr/bin/env bash
# Prints the signature of a backup file: HMAC-SHA256 under a key derived from BACKUP_PASSPHRASE.
# The passphrase itself never appears in a command line; the derived key only signs, it cannot
# decrypt. Works with OpenSSL and LibreSSL.
#   BACKUP_PASSPHRASE=... ./backup-mac.sh backups/mezmitra-20261015T210000Z.dump.enc
set -euo pipefail
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
FILE="${1:?usage: backup-mac.sh <file>}"
# The salt keeps the product's earlier name so backups signed before the rename still verify.
key="$(printf '%s' "dineos-backup-signature:${BACKUP_PASSPHRASE}" | openssl dgst -sha256 | awk '{print $NF}')"
openssl dgst -sha256 -hmac "$key" "$FILE" | awk '{print $NF}'
