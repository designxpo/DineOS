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

### Database on Supabase (optional)

The database can be a Supabase project's Postgres; DineOS uses it as plain PostgreSQL (its own roles, migrations and API; not the Supabase Data API, Auth or client libraries).

1. Put the connection details in a gitignored file such as `.env.supabase.local` (see the one in the repo root of the setup machine): `DATABASE_OWNER_URL` is Supabase's `postgres` user through the **session** pooler (port 5432); `DATABASE_URL` and `DATABASE_ADMIN_URL` are `dineos_app.<project-ref>` and `dineos_admin.<project-ref>` through the **transaction** pooler (port 6543), with passwords you choose in `DINEOS_APP_PASSWORD` / `DINEOS_ADMIN_PASSWORD`.
2. `DINEOS_ENV_FILE=.env.supabase.local npm run db:setup` creates the two roles; `DINEOS_ENV_FILE=.env.supabase.local npm run db:migrate` applies every migration.
3. Run the API with the same `DINEOS_ENV_FILE`. Tests keep using the local database.

Migration 0013 removes every privilege Supabase gives its Data API roles (`anon`, `authenticated`) in schema public, so the publishable key cannot read or call anything; 0014 matches Supabase's automatic RLS on platform tables. In the Supabase dashboard you can also turn the Data API off entirely. Pick the **Mumbai (ap-south-1)** region for real customer data: the spec asks for India-region hosting.

### Vercel (web and API as one project)

`vercel.json` deploys two services on one domain: `web` (Next.js) serves every page, and `api` (Fastify) receives `/v1/*`, `/socket.io/*` and `/healthz`. The database stays on Supabase. The print agent, outlet hub and camera box still run inside the restaurant; point their `DINEOS_API_URL` at the site's address.

1. Import the GitHub repository in Vercel. Keep the project's Root Directory empty: `vercel.json` sits at the repo root.
2. Add Redis from the Vercel Marketplace (Upstash). Live updates reach screens connected to other instances through it; the API reads `REDIS_URL` (or `KV_URL`).
3. In Supabase, create a **public** Storage bucket (e.g. `dineos`) for menu photos and logos, and an S3 access key (Storage → S3 Connection).
4. Set these environment variables in the Vercel project:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL`, `DATABASE_ADMIN_URL` | The transaction-pooler URLs from `.env.supabase.local` |
   | `TOKEN_SECRET` | The same value as before; it signs printed QR codes |
   | `GUEST_URL_TEMPLATE` | `https://<your-domain>/t/{token}` |
   | `CORS_ORIGINS`, `PUBLIC_API_URL` | `https://<your-domain>` |
   | `CRON_SECRET` | 16+ random characters; Vercel Cron sends it to `/v1/internal/maintenance` |
   | `STORAGE_DRIVER` | `s3` |
   | `S3_ENDPOINT` | `https://<project-ref>.storage.supabase.co/storage/v1/s3` |
   | `S3_REGION` | The Supabase project's region, e.g. `ap-southeast-2` |
   | `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | The bucket and key from step 3 |
   | `S3_PUBLIC_URL` | `https://<project-ref>.supabase.co/storage/v1/object/public/<bucket>` |

   Leave `NEXT_PUBLIC_API_URL` unset: the web app then calls the API on its own domain (the production domain, or a preview's own address). Scope the database variables to Production unless previews should share live data.
5. Keep `regions` in `vercel.json` next to the database (`syd1` for a Sydney project, `bom1` for Mumbai): every request makes several queries.
6. Run migrations from your machine as before (`DINEOS_ENV_FILE=.env.supabase.local npm run db:migrate`); deployments never change the schema.

How the API behaves on Vercel:

- **Live updates** use Vercel's WebSocket support (beta). A connection closes when the function reaches its time limit (5 minutes on Hobby, up to 800 seconds on Pro); screens reconnect and fetch what they missed, so nothing is lost.
- **Housekeeping** runs at most hourly from normal traffic, plus a daily cron at about 3 am IST (Hobby allows one run a day; on Pro you can change the schedule in `vercel.json` to `0 * * * *`).
- **Request bodies** are capped at 4.5 MB. Menu photos are resized in the browser; the hub sends offline changes in batches of about 3 MB; bank statements over about 3 MB need splitting.
- Vercel's Hobby plan is for non-commercial use. Move to Pro before charging restaurants.

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
8. Optional, any time: **Settings → Loyalty & stock** (points, booking length, automatic sold-out), **Inventory** (ingredients and recipes), **Settings → Printers → Offline mode** (outlet hub), **Settings → Cameras**.

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

## Outlet hub (offline mode)

The same print agent, started with `DINEOS_HUB=1`, keeps the outlet trading when its internet line is down. Staff screens offer "Switch to outlet hub" after 30 seconds without a connection; orders, the kitchen display, bills (with the offline invoice series) and payments carry on over the outlet's Wi-Fi, and everything is sent to DineOS when the line returns.

1. Pick an always-on PC on the outlet's network (the print-agent PC is fine) and give it a fixed IP in the router.
2. **Settings → Printers → Offline mode**: choose that device and enter its address, e.g. `http://192.168.1.20:4100`.
3. On the PC run the hub and, beside it, the staff web app (the same `web` image as the cloud), so the app is served on the LAN:

```bash
docker run -d --restart=always --name dineos-web -p 127.0.0.1:3000:3000 \
  -e NEXT_PUBLIC_API_URL=https://API_DOMAIN dineos-web:<version>
DINEOS_HUB=1 DINEOS_HUB_PORT=4100 DINEOS_HUB_DATA=/var/lib/dineos/hub.json \
DINEOS_HUB_WEB=http://127.0.0.1:3000 DINEOS_API_URL=https://API_DOMAIN \
DINEOS_DEVICE_TOKEN=dv_... node main.js
```

4. Staff must have signed in on each device while online; the hub recognises their sessions by hash.
5. Rehearse: unplug the router, switch a tablet to the hub, take an order and a payment, plug back in, and check the bill under **Bills** and in the GST report (series `PREFIXH`).

- `GET http://<hub>:4100/hub/status` shows whether the cloud is reachable, whether changes are waiting, and anything the cloud refused (also logged, and shown in the hub's banner).
- Back up `hub.json` with the PC. If the PC dies while offline, bills made on it reach DineOS only from that file.
- While the hub and every staff screen are cut off, the cloud pauses QR ordering for that outlet so guests are told to order with a waiter.

## Camera box (optional)

See `edge/vision-worker/README.md` for hardware, installing the model and running the service. In the portal: **Settings → Cameras → Add camera box**, add each camera with a stream name, then **Draw table zones** on its picture. **Reports → Camera** shows how often the camera agreed with the till; run it for two weeks before relying on camera states at a new outlet.

## UPI check

Managers download the account statement from net banking (CSV or Excel) and import it in **UPI check**, weekly or at month end. Act on two lists: UPI payments the bank never received (ask the cashier for the guest's UTR or payment screen), and UPI credits with no bill (match them, or set aside money that is not a sale). Re-importing an overlapping statement is safe.

## Charge to room (hotel outlets)

Turn on **Settings → Billing & UPI → Charge bills to hotel rooms**. Cashiers then get a **Room** payment method that asks for the room number (and optionally the guest's name); a bill can be split between cash and a room. The front desk opens **Reports → Room charges**, posts the per-room totals to the guests' folios (or imports the CSV into the hotel system), ticks the charges and presses **Mark posted**; only managers and owners can. Refunds of a room charge show as negative lines for the same room. Do this at least daily, before guests check out.

## Maintenance job

Runs hourly on one API server (advisory lock) and can be run by hand with `node apps/api/dist/maintenance.js`: prunes old events, idempotency keys, sessions and print jobs; releases tables where guests browsed but never ordered; marks reservations as no-shows after the grace period; closes stale waitlist entries; deletes camera stills older than a day.

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
