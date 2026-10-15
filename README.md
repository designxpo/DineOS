# DineOS

Multi-tenant restaurant and cafe platform for India: guests order from a table QR code on their own phone, orders reach the kitchen display and the manager's inbox in well under two seconds, and cashiers settle GST invoices with cash, the outlet's own UPI QR, card slips or split payments. Built to the Phase 1 scope of the *Restaurant & Cafe SaaS dev spec*.

| Surface | Path | Who uses it |
| --- | --- | --- |
| Guest QR menu (PWA, no app, no login, English/Hindi) | `/t/{table token}` | Guests |
| Staff and owner portal: orders inbox, kitchen display, floor map, POS, bills, menu, tables and QR, reports, staff, settings | `/app` | Owners, managers, cashiers, waiters, kitchen |
| Platform admin: restaurants, plans, subscription invoices, usage, support access | `/admin` | You |
| Print agent for ESC/POS kitchen and bill printers | `apps/print-agent` | Runs on one PC per outlet |

## Run it locally

Needs Node 22+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env                      # then set TOKEN_SECRET to 32+ random characters
npm run db:setup && npm run db:migrate    # creates roles and the dineos_dev database
npm run db:seed                           # a hotel restaurant pilot with menu, 22 tables and staff
npm run dev                               # API on :4000, web on :3000
```

Open <http://localhost:3000/login> and sign in with restaurant code `aurum-courtyard`:

| Role | Login | Password |
| --- | --- | --- |
| Owner | owner@courtyard.demo | demo1234 |
| Manager (approval PIN 1234) | arjun@courtyard.demo | demo1234 |
| Cashier | priya@courtyard.demo | demo1234 |
| Waiter | ravi@courtyard.demo | demo1234 |
| Kitchen | imran@courtyard.demo | demo1234 |
| Platform admin, at `/admin/login` | admin@dineos.local | admin-demo-1234 |

To act as a guest, open **Floor**, tap a table and choose **Guest menu**, or print the QR sheet from **Tables & QR**. Phones on your network can scan it if you set `GUEST_URL_TEMPLATE` and `NEXT_PUBLIC_API_URL` to your machine's LAN address.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | All tests: shared billing/state rules, the API against a real Postgres (including the cross-tenant suite), print agent layouts |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript across the monorepo |
| `npm run db:migrate` then `npm run db:codegen -w @dineos/api` | Apply a new migration and regenerate the typed schema |
| `node infra/load/load-test.mjs` | Load test at the spec's scale target (see docs/operations.md) |
| `infra/backup/backup.sh`, `infra/backup/restore-drill.sh` | Encrypted backup; restore the newest backup into a scratch database and verify it |
| `DINEOS_DRY_RUN=1 DINEOS_DEVICE_TOKEN=dv_... npm start -w @dineos/print-agent` | Run the print agent without a printer and see the tickets as text |

## What is in Phase 1

All nine Phase 1 epics: foundations (auth, tenants, outlets, roles, row-level security, audit log), menu management with spreadsheet import, tables and signed QR codes with a printable PDF sheet, guest ordering with a shared live cart, order inbox and kitchen display, POS and GST billing with splits and a gap-free invoice series, floor operations, platform admin with manual subscription invoices, and hardening.

The acceptance criteria in spec §14 are automated:

| Criterion | Verified by |
| --- | --- |
| QR order with a modifier shows in the owner portal and KDS in under 2 s | `apps/api/test/guest.test.ts` (real sockets); load test p99 26 ms at 60 tables / 300 phones on one machine |
| Out of stock reaches every open guest menu in under 2 s | `guest.test.ts` |
| Rejecting an order notifies the guest with the reason | `guest.test.ts` |
| A closed table's old QR session cannot place an order | `guest.test.ts` |
| Tenant A cannot read any row of tenant B through any endpoint | `cross-tenant.test.ts` probes every route and snapshots tenant B; `rls.test.ts` checks every table at the database |
| Split three ways, mixed cash and UPI, GST invoice with a gap-free number | `billing.test.ts`, including concurrent finalising and rollback |
| Restoring last night's backup into a clean environment succeeds | `infra/backup/restore-drill.sh` |

## Decisions that differ from the spec

- **No Web Push.** PWA push goes through Google, Apple or Mozilla servers, which would break the no-third-party rule. Staff get in-app sound and alerts while the portal is open.
- **Service charge** is off by default and staff can remove it from any bill, because Indian consumer guidelines bar charging it automatically.
- **GST rate** is set per dish with an outlet default; the seed uses 5%. For a hotel restaurant the right rate can depend on room tariffs, so confirm with your accountant before the pilot.
- **No BullMQ.** Live events and print jobs live in Postgres (a transactional outbox with a per-outlet sequence), so nothing is lost if a process dies; Redis is only used to fan sockets out across API servers.
- **Staff sessions are database tokens**, not JWTs, so disabling someone signs them out at once.
- **StayOS bill-to-room** is deferred; record it as payment method "Other" with the room number as the reference.
- **Every foreign key between tenant tables also matches `tenant_id`.** Postgres checks foreign keys without row-level security, so this stops one tenant's rows from pointing at another's.

## Before the pilot

- Confirm GST rates, the invoice format and HSN/SAC codes with an accountant.
- Test the print agent with the outlet's actual printers (layouts are tested; real hardware is not).
- Build the Docker images: CI does this on every push. They could not be built on the development machine because Docker was not running.
- Point a domain at the server. Tenant subdomains (`slug.yourdomain`) are optional and need a wildcard certificate.
- Configure a second backup location; `backup.sh` warns while there is none.

## Docs

- [docs/architecture.md](docs/architecture.md): how the system fits together, tenancy, realtime, billing, and conventions for adding features
- [docs/operations.md](docs/operations.md): deploying, onboarding a restaurant, the print agent, backups, scaling and security
- Spec and decisions: [docs/specs/](docs/specs/)
