# Operations

## Deploy on one server

A rented VM in an India region with 4 vCPU and 8 GB RAM is plenty for the first hundreds of outlets.

```bash
git clone <repo> /opt/dineos && cd /opt/dineos
cp .env.production.example .env.production   # fill every secret: openssl rand -hex 32
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production run --rm api \
  node apps/api/dist/create-admin.js --email you@yourcompany.in --name "Your Name" --password '<12+ chars>'
```

- DNS: point `APP_DOMAIN` and `API_DOMAIN` at the server. Caddy obtains and renews TLS certificates.
- The `migrate` service applies database migrations before the API starts, on every deploy.
- Health: `GET https://API_DOMAIN/healthz`. Logs: `docker compose logs -f api`.
- `TOKEN_SECRET` signs every table QR code. Keep it stable; changing it invalidates all printed QR codes.

### Scaling

- More API capacity: run several `api` containers (`docker compose up -d --scale api=3`). Redis carries live events between them, and the hourly maintenance job runs on only one, using an advisory lock.
- The database is the shared state. Move it to a managed or dedicated Postgres 16 with point-in-time recovery when one VM is no longer enough.
- Menu photos: switch `STORAGE_DRIVER=s3` and point it at MinIO (`--profile s3`) or any S3-compatible bucket you own.

## Onboard a restaurant

1. Admin console → **New restaurant**: business name, restaurant code (used to sign in), plan, owner, first outlet.
2. The owner signs in and, in **Settings**, fills in GSTIN, FSSAI, address, invoice prefix and UPI ID, and decides on auto-accept and service charge.
3. **Menu → Import**: download the template, fill it in Excel, check the file, then import. Add photos per dish.
4. **Tables & QR**: add tables (or "Add many"), then print the QR sheet (PDF) and place the cards.
5. **Staff**: add managers, cashiers, waiters and kitchen staff. Managers set an approval PIN in **Settings → My PIN**.
6. Optional printers: **Settings → Printers → Add print agent**, then install the agent (below).
7. Subscription: create a monthly invoice in the admin console; mark it paid when the UPI or bank transfer arrives.

## Print agent

Runs on any always-on PC at the outlet (Windows, Linux, or a Raspberry Pi) on the same network as the thermal printers. It connects out to the API, so no port forwarding is needed.

```bash
npm run build -w @dineos/print-agent        # produces apps/print-agent/dist/main.js (single file)
# copy main.js to the outlet PC, which needs Node 22+
DINEOS_API_URL=https://API_DOMAIN DINEOS_DEVICE_TOKEN=dv_... node main.js
```

- Keep it running as a service: NSSM on Windows, a systemd unit on Linux.
- Printer addresses (`192.168.1.50:9100`, 80 mm = 48 columns, 58 mm = 32) are set per device in the portal; restart the agent after changing them. **Settings → Printers → Test** prints a test page.
- Jobs are acknowledged once printed. Failures retry up to five times, and jobs left unprinted while the PC was off print when it reconnects. If the agent is down, kitchen staff still see orders on the KDS, and bills can be printed from the browser.

## Backups

- Nightly encrypted dump with a second copy elsewhere (spec §12):
  `30 2 * * * cd /opt/dineos && docker compose --env-file .env.production --profile ops run --rm backup`
- Set `BACKUP_RSYNC_TARGET` (ssh) or `BACKUP_S3_URI` (bucket you own). A backup only on the same server does not count.
- Keep `BACKUP_PASSPHRASE` in a password manager, not only on the server. Without it the backups cannot be read.
- Monthly restore drill (also before any risky migration):
  `DATABASE_OWNER_URL=... BACKUP_PASSPHRASE=... BACKUP_DIR=... infra/backup/restore-drill.sh`
  It restores the newest backup into a scratch database, checks migrations, RLS, gap-free invoice numbers and row counts against the backup's manifest, then drops the scratch database. A non-zero exit means investigate.
- To restore for real: `infra/backup/restore.sh <file.dump.enc> <empty-database-url>`, then set role passwords and point the API at it.

## Load test

```bash
# API started with GUEST_JOIN_RATE_LIMIT=100000 RATE_LIMIT_MAX=100000 (all simulated phones share one IP)
API_URL=https://staging-api... ADMIN_EMAIL=... ADMIN_PASSWORD=... node infra/load/load-test.mjs
```

It creates a throwaway restaurant, joins 300 guests across 60 tables, connects 10 staff screens, orders for a minute, and reports latency from "Order now" to the staff screen (budget 2 s). On a single development machine: p99 26 ms with no losses. Run it against staging from another machine for realistic network latency, then suspend and purge the throwaway restaurant.

## Data rights

- Export: owners download everything from **Settings → Brand & plan → Export data** (credentials excluded).
- Delete: suspend the restaurant in the admin console, then run
  `node apps/api/dist/purge-tenant.js --slug <code> --confirm <code>`. Backups keep the data until they age out.

## Security checklist

- Only `dineos_app` credentials go to the API's `DATABASE_URL`; never the owner role.
- Secrets live in `.env.production` (mode 600) and the password manager, not in git.
- Rate limits: 600 requests per minute per token or IP, guest joins 120 per minute per IP, logins 10 per minute, guest orders limited per phone and per table.
- Support access to a restaurant is time-limited (1 hour), needs a written reason, and appears in that restaurant's audit log.
- Run `npm audit --omit=dev` before each release; CI runs lint, types, migrations, all tests and Docker builds on every push.
