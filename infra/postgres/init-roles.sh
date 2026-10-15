#!/usr/bin/env bash
# Runs once when the Postgres volume is first created (docker-entrypoint-initdb.d).
# The container's POSTGRES_USER is the schema owner (superuser); the API never connects as it.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  create role dineos_app login password '${DINEOS_APP_PASSWORD}' nobypassrls nosuperuser nocreatedb nocreaterole;
  create role dineos_admin login password '${DINEOS_ADMIN_PASSWORD}' bypassrls nosuperuser nocreatedb nocreaterole;
SQL
