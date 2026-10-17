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
- `REDIS_PASSWORD` protects Redis even on the private Docker network (use `openssl rand -hex 32`, so it fits in the connection URL). Containers run with no extra Linux capabilities, cannot gain privileges, and have CPU and memory caps; raise the caps in `docker-compose.yml` on a bigger server.

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
   | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional, for phone alerts: generate with `npx web-push generate-vapid-keys`. Changing them makes every device turn alerts on again |
   | `VAPID_SUBJECT` | `https://<your-domain>` or `mailto:` an address push services can reach |
   | `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID` | Optional, for loyalty codes by SMS (see below) |

   Leave `NEXT_PUBLIC_API_URL` unset: the web app then calls the API on its own domain (the production domain, or a preview's own address). Scope the database variables to Production unless previews should share live data.
5. Keep `regions` in `vercel.json` next to the database (`syd1` for a Sydney project, `bom1` for Mumbai): every request makes several queries.
6. Run migrations from your machine as before (`DINEOS_ENV_FILE=.env.supabase.local npm run db:migrate`); deployments never change the schema. **Migrate before you push code that needs a new column**: a deploy that writes to a column the database lacks fails on every such request.

How the API behaves on Vercel:

- **Live updates** use Vercel's WebSocket support (beta). A connection closes when the function reaches its time limit (5 minutes on Hobby, up to 800 seconds on Pro); screens reconnect and fetch what they missed, so nothing is lost.
- **Housekeeping** runs at most hourly from normal traffic, plus a daily cron at about 3 am IST (Hobby allows one run a day; on Pro you can change the schedule in `vercel.json` to `0 * * * *`).
- **Rate limits** (sign-in, PIN, guest joins, orders) are counted in Redis when `REDIS_URL` is set, so they hold across API copies. Without Redis each copy counts on its own; if Redis is unreachable, requests go through.
- **Phone alerts** are sent after the response; `waitUntil` keeps the function alive until they finish.
- **Request bodies** are capped at 4.5 MB. Menu photos are resized in the browser; the hub sends offline changes in batches of about 3 MB; bank statements over about 3 MB need splitting.
- Vercel's Hobby plan is for non-commercial use. Move to Pro before charging restaurants.

### Scaling

- More API capacity: run several `api` containers (`docker compose up -d --scale api=3`). Redis carries live events between them, and the hourly maintenance job runs on only one, using an advisory lock.
- The database is the shared state. Move it to a managed or dedicated Postgres 16 with point-in-time recovery when one VM is no longer enough.
- Menu photos: switch `STORAGE_DRIVER=s3` and point it at MinIO or any S3-compatible bucket you own (see Object storage below).

### Object storage

Menu photos and logos must be readable by guest phones; nothing else in the bucket should be, and nobody should be able to list it.

- **Supabase Storage** (the Vercel setup): a public bucket serves files by exact path only; leave the default policies, which do not let anonymous users list objects.
- **AWS S3**: keep *Block public access* on for ACLs (`BlockPublicAcls`, `IgnorePublicAcls`) and allow reads of the photo folders only by bucket policy:
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "PublicMenuPhotos",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": ["arn:aws:s3:::BUCKET/*/menu/*", "arn:aws:s3:::BUCKET/*/branding/*"]
    }]
  }
  ```
- **Bundled MinIO**: start it with the extra file, which refuses to run without `S3_ACCESS_KEY` and `S3_SECRET_KEY` (long random values, no defaults):
  `docker compose -f docker-compose.yml -f docker-compose.s3.yml --env-file .env.production up -d`
  Then allow anonymous reads of the photo folders only (`mc anonymous set-json` with the policy above, `arn:aws:s3:::BUCKET/*/menu/*` and `.../branding/*`), never `mc anonymous set download` on the whole bucket, which also allows listing it.
- Uploads are checked by their content, not their name: only real JPG, PNG and WebP files are stored. The API serves stored files (fs driver) only if they are images inside the storage folder, with headers that stop a browser from running anything in them.

## Onboard a restaurant

1. Admin console → **New restaurant**: business name, restaurant code (used to sign in), plan, owner, first outlet.
2. The owner signs in and, in **Settings**, fills in GSTIN, FSSAI, address, invoice prefix and UPI ID, and decides on auto-accept and service charge.
3. **Menu → Import**: download the template, fill it in Excel, check the file, then import. Add photos per dish.
4. **Tables & QR**: add tables (or "Add many"), then print the QR sheet (PDF) and place the cards.
5. **Staff**: add managers, cashiers, waiters and kitchen staff. Managers set an approval PIN in **Settings → My PIN**.
6. Optional printers: **Settings → Printers → Add print computer**, then paste the install line on the billing PC (below).
7. Subscription: create a monthly invoice in the admin console; mark it paid when the UPI or bank transfer arrives.
8. Optional, any time: **Settings → Loyalty & stock** (points, booking length, automatic sold-out), **Inventory** (ingredients and recipes), **Settings → Printers → Offline mode** (outlet hub), **Settings → Cameras**.

## Printers: kitchen tickets (KOT), bills and the cash drawer

One always-on computer at the outlet runs the DineOS print agent, usually the billing PC (Windows), or a Mac, a Linux PC or a Raspberry Pi. Thermal printers connect to it in any of these ways:

| Printer | How it connects | Address the agent uses |
| --- | --- | --- |
| USB printer at the billing desk | Plugged into the computer, with its Windows (or CUPS) driver installed | `printer:<name>`, e.g. `printer:EPSON TM-T82 Receipt` |
| Network printer in the kitchen or bar | Ethernet or Wi-Fi on the outlet's network; give it a fixed IP in the router | `192.168.1.50:9100` |
| USB printer on Linux / Raspberry Pi | Plugged in; no driver needed | `/dev/usb/lp0` |

Any ESC/POS (Epson-compatible) 58 or 80 mm printer works: Epson TM-T82/T88, TVS RP3160, Rugtek, Posiflex, Everycom and most others sold in India. A cash drawer plugs into the bill printer's RJ11 "DK" port.

1. **Settings → Printers → Add print computer**. Pick Windows, Mac or Linux, copy the line, and run it on that computer (Windows: PowerShell **as administrator**; Linux: it uses `sudo`). It installs Node.js if needed, downloads the agent from your DineOS site (`/agent/dineos-agent.mjs`), and starts it with the computer: a scheduled task on Windows (`C:\ProgramData\DineOS`, runs as SYSTEM), a systemd service on Linux (`/opt/dineos`), a launch agent on a Mac. Run the line again to update the agent. The log is `agent.log` in that folder.
2. Within a minute the computer shows as **Online**, with the printers it found: printers installed on it, Linux USB devices, and network printers answering on port 9100 on its local network. **Search for printers** looks again after plugging one in.
3. **Choose printers**: one printer per job (bills and each kitchen station), or the same printer for several. Set 80 or 58 mm paper, and switch on **Open the cash drawer on cash payments** for the bill printer if a drawer is attached. Changes reach the computer within seconds; no restart. **Test** prints a test page.

How it behaves:
- Accepted orders print one KOT per station on that station's printer; a station with no printer shows only on the kitchen screen. Finalising a bill prints it at the billing desk; a cash payment opens the drawer.
- Jobs are acknowledged once printed and retried up to five times. Jobs queued while the computer was off print when it comes back. On hosts where the agent cannot keep its live connection (some serverless hosts), it checks for jobs every 5 seconds instead.
- If a ticket or bill has not printed after 90 seconds, or failed, every staff screen (including the kitchen screen) shows a red **Printer problem** bar naming it, with **Print here** (browser printing on that device), **Try again** and **Done**.
- To remove the agent: Windows `Unregister-ScheduledTask -TaskName 'DineOS Print Agent' -Confirm:$false`; Linux `sudo systemctl disable --now dineos-print-agent`; Mac `launchctl unload ~/Library/LaunchAgents/in.dineos.print-agent.plist`. **Remove** on its card stops it printing at once.
- Developers: after changing `apps/print-agent`, run `npm run build:download -w @dineos/print-agent` and commit `apps/web/public/agent/dineos-agent.mjs` with its `.sha256`; installers download the file and refuse it if the checksum does not match. `DINEOS_DRY_RUN=1` prints tickets as text, `DINEOS_SCAN=0` skips the printer search, `DINEOS_SCAN_HOSTS=10.0.5.20,10.0.5.21` checks printers on another network.

## Outlet hub (offline mode)

The same print agent, installed with **Also keep the outlet running offline on this computer** switched on (or started with `DINEOS_HUB=1`), keeps the outlet trading when its internet line is down. Staff screens offer "Switch to outlet hub" after 30 seconds without a connection; orders, the kitchen display, bills (with the offline invoice series) and payments carry on over the outlet's Wi-Fi, and everything is sent to DineOS when the line returns.

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
- Each backup is signed (`.hmac`, keyed from `BACKUP_PASSPHRASE`), so a changed or swapped file is caught; a plain checksum next to the file would not catch a swap. `restore.sh` refuses any backup it cannot verify. Backups made before signing have only a `.sha256`; restore one of those with `ALLOW_UNSIGNED_BACKUP=yes` (it is then checked for damage only). Copy the `.hmac` and `.sha256` files with the backups.

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
- Manager PINs: five wrong PINs in a row lock that manager's PIN for 15 minutes, whichever screen or network they came from. The owner gets a phone alert, the attempt is in the audit log, and setting a new PIN (My account) lifts the lock.
- Every API response carries security headers (no sniffing, no framing, a no-script content policy, no referrer, HSTS in production), so they hold on Vercel where there is no proxy in front.
- The print agent installers check the download against the checksum published with the site (`/agent/dineos-agent.mjs.sha256`) and accept only HTTPS addresses. The checksum catches a damaged or wrong download; the site's HTTPS certificate is what vouches for the source.
- Run `npm audit --omit=dev` before each release; CI runs lint, types, migrations, all tests and Docker builds on every push.

## Loyalty codes by SMS (MSG91)

With `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID` set, a guest joining loyalty from the table gets a six-digit code by SMS and sees their name and points once it is right. DineOS makes and checks the codes (hashed, ten minutes, five tries); MSG91 only delivers them.

1. Create an MSG91 account and complete its KYC.
2. TRAI requires DLT registration: register your business as a principal entity, a sender ID (header), and an OTP content template such as `{#var#} is your DineOS code. It expires in 10 minutes.` (MSG91's help pages walk through the operator portals).
3. In MSG91, create an OTP template linked to that DLT template, with `##OTP##` where the code goes, and note its template ID. If you restrict the auth key to IP addresses, allow Vercel's (or turn the restriction off).
4. Set `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID` in Vercel and redeploy. Test with your own number first.

Limits: three codes per number in fifteen minutes and a hundred per outlet an hour, so a script cannot run up the SMS bill.

## Phone alerts (Web Push)

With the VAPID keys set, staff turn alerts on per device under **My account → Alerts on this phone**. On iPhone (iOS 16.4 or later) DineOS must be added to the Home Screen and opened from there first. Alerts go to staff who can act at that outlet: new guest orders to those who accept orders, waiter calls and bill requests to those who handle them, and food or drinks ready to serve to waiters (and counter staff, for takeaway and delivery). A table with an assigned waiter alerts that waiter, not the others. Signing out turns the device's alerts off.

## Bar and kitchen

Guests order drinks and food from one menu, and each dish goes to its own station. Set the stations under **Settings** and each dish's station in **Menu**. When an order is accepted it splits into one kitchen ticket per station, printed on that station's printer, and a kitchen screen set to **Bar** shows only drinks. Each station marks its own part ready. When the bar's part of an order is ready while the kitchen still cooks, the waiter hears a double ding and sees "Table C4: Bar ready", and so does their phone. The order card offers **Mark N served** for what is at the pass, and the floor tile shows how many items are waiting. The bar's ticket leaves the bar screen once its drinks are served, and the whole order moves to **Ready to serve** when the food is done.

## Delivery orders

Enter Zomato and Swiggy orders at the POS (type **Delivery**) with the platform's order number; they go to the kitchen like any order. Set each platform's commission under **Settings → Billing**. Because the platform pays the GST on these orders (CGST Act s. 9(5)), their bills carry no tax, print a note saying so, and are closed with **Mark paid on the app**; the GST report lists them apart from your taxable sales. Confirm the treatment, and how to report it in GSTR-1, with your accountant. Own-rider deliveries are billed with GST like takeaway. The outlet hub does not take new delivery orders or bill platform orders while offline.

## Tables without cameras

Most cafés have no cameras, so the floor reads the tables from what guests and staff already do:

- **Guests sit down and scan the table QR**: the table turns **Occupied** with "Guests here" at once, before anyone orders. If nobody has seated them or taken an order after 5 minutes, the tile pulses "Guests waiting" and staff on the Orders and Floor screens hear a chime (a floor-only waiter hears only their own tables). A scan counts for 20 minutes without any activity.
- **Guests who do not scan**: tap the table on the floor, then the number of guests (1 to 6, or More). Seating clears any "Needs cleaning".
- **Guests leave**: paying the bill closes the visit and the table shows **Needs cleaning**. It counts as free again after the outlet's clearing time (**Settings → Ordering → After guests leave**, 10 minutes by default; "Only when staff mark it clean" turns this off). Until then the tile counts down. When staff clear tables by hand, the tile pulses after 10 minutes.
- **Bottled water on tables**: choose the dish to bill opened bottles as (**Settings → Ordering → Bottled water on tables**). A table's bill then cannot print until someone taps how many bottles were opened (or None). The count goes on the bill as a served item with no kitchen ticket, and can be changed until the bill prints.

## Counter-service cafés

Counter and takeaway orders get a number guests collect with:

- The bill (printed and on screen) shows **ORDER 23** and a QR. Guests scan it to follow the order on their phone (`/o/<code>`): received, being made, ready. The phone chimes and vibrates when it is ready, if they tapped "Play a sound".
- **Settings → Ordering → Pickup screen** gives a link for a TV or tablet by the counter. It shows the numbers being made and ready to collect (delivery orders show the platform), and chimes when one turns ready. Mark the order served when it is handed over and it leaves the screen; ready orders also drop off after 30 minutes. **New link** stops old screens.
