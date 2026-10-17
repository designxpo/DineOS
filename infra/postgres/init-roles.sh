#!/usr/bin/env bash
# Runs once when the Postgres volume is first created (docker-entrypoint-initdb.d).
# The container's POSTGRES_USER is the schema owner (superuser); the API never connects as it.
set -euo pipefail
# MEZMITRA_*; DINEOS_* (the product's earlier name) still work on servers set up before the rename.
APP_PASSWORD="${MEZMITRA_APP_PASSWORD:-${DINEOS_APP_PASSWORD:?set MEZMITRA_APP_PASSWORD}}"
ADMIN_PASSWORD="${MEZMITRA_ADMIN_PASSWORD:-${DINEOS_ADMIN_PASSWORD:?set MEZMITRA_ADMIN_PASSWORD}}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  create role dineos_app login password '${APP_PASSWORD}' nobypassrls nosuperuser nocreatedb nocreaterole;
  create role dineos_admin login password '${ADMIN_PASSWORD}' bypassrls nosuperuser nocreatedb nocreaterole;
SQL
