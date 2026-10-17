# Mezmitra Security & Cloud Security Audit Report
**Audit Date**: October 2026  
**Auditors**: Senior Security Engineer & Cloud Security Architect (`/senior-security` & `/cloud-security`)  
**Scope**: Mezmitra Monorepo (`apps/api`, `apps/web`, `apps/print-agent`, `edge/vision-worker`, `packages/shared`, `infra/`, `docker-compose.yml`, `.github/workflows/ci.yml`)

---

## Executive Summary

A comprehensive security assessment was conducted across application code, multi-tenant isolation mechanisms, cryptographic implementations, edge computing interfaces, and cloud infrastructure configurations.

Mezmitra displays **advanced architectural security maturity** in several foundational areas:
- **Tenancy Isolation**: Enforced at the database engine level via PostgreSQL Row-Level Security (RLS) with composite `(id, tenant_id)` foreign keys that neutralize native PostgreSQL cross-tenant relational bypasses.
- **Cryptographic Practices**: Scrypt with per-user salt and timing-safe comparisons for credentials; HMAC-SHA256 purpose-separated tokens for guest sessions, table QR codes, and counters.
- **Privacy by Design**: Edge vision processing runs strictly on premise; video streams never leave the restaurant; camera reference stills are blurred and purged after 24 hours. Customer data management adheres to the Indian Digital Personal Data Protection (DPDP) Act 2023 with mandatory consent recording and right-to-erasure workflows.
- **Supabase Data API Lockdown**: Explicit removal of default PostgREST access privileges from `anon` and `authenticated` roles in migration `0013`.

However, the audit identified **specific vulnerabilities and cloud configuration weaknesses** that require immediate remediation before commercial deployment:
1. **Unauthenticated Internal Redis Service** in `docker-compose.yml` (High).
2. **Missing In-Memory Auth Cache Eviction** leading to potential stateful memory exhaustion (Medium).
3. **MIME-Type-Only File Upload Validation** without magic bytes checking (Medium).
4. **Weak File Path Containment Check** in the storage driver (Medium).
5. **Manager PIN Brute-Force Exposure** lacking progressive delays or per-account lockout (Medium).
6. **Missing Application-Layer Security Headers** (`@fastify/helmet` omitted) (Low/Medium).
7. **Container Hardening Gaps** in `docker-compose.yml` (no resource limits, no capability drop) (Low).

---

## 1. Threat Modeling (STRIDE Methodology)

The system was decomposed into trust boundaries:
- **Boundary 1 (Public Internet / Guests)**: Guest QR PWA (`/t/{token}`) accessing `/v1/guest/*`.
- **Boundary 2 (Staff / Outlets)**: Cashiers, waiters, managers accessing `/v1/*` via staff tokens (`st_...`).
- **Boundary 3 (Platform Administration)**: Platform superadmins accessing `/v1/admin/*` via admin tokens (`ad_...`).
- **Boundary 4 (Outlet Premise / Edge)**: Print agent and outlet hub accessing `/v1/device/*` via device tokens (`dv_...`).
- **Boundary 5 (Internal Infrastructure)**: Fastify API, PostgreSQL, Redis, Caddy, MinIO/S3.

### STRIDE Assessment Matrix

| Element | Threat Category | Threat Description | Mezmitra Defense Status | Residual Risk |
| :--- | :--- | :--- | :--- | :--- |
| **Guest QR & Token** | **Spoofing** | Adversary attempts to forge guest tokens to view or mutate table orders. | HMAC-SHA256 signed with secret key; table QR versioning allows instantaneous invalidation. | **Low** |
| **Staff & Admin Sessions** | **Spoofing** | Session token theft or brute-forcing. | Cryptographically random 256-bit bearer tokens (`st_...`, `ad_...`), stored as SHA-256 hashes in DB. | **Low** |
| **Guest Orders & Cart** | **Tampering** | Guest alters dish price or tax rates in HTTP request payload. | `prepareLines()` in `orders/service.ts` re-queries the database for prices and rules; client prices ignored. | **Mitigated** |
| **Billing & Invoices** | **Tampering** | Concurrent cashiers forge or skip invoice numbers. | Sequential invoice generator uses row-locked counters (`nextCounter`); rollbacks restore sequence. | **Mitigated** |
| **Auditing & Logs** | **Repudiation** | Staff member denies voiding a bill, refunding money, or altering customer points. | `audit_log` records tenant_id, actor_id, action, before/after snapshots, and reasons. | **Mitigated** |
| **Camera & Video** | **Information Disclosure** | Leakage of customer video streams or identifiable CCTV footage. | Raw video never leaves premise; only derived states sent over HTTPS; zone stills blurred and purged after 24h. | **Mitigated** |
| **Tenant Data** | **Information Disclosure** | Tenant A queries Tenant B's sales reports, tables, or staff. | PostgreSQL RLS forced on every business table; composite foreign keys prevent relational leaks. | **Mitigated** |
| **Storage & Uploads** | **Information Disclosure** | Path traversal via `/files/*` to read host files. | `safeKey()` normalizes path and checks `..`, but lacks strict base directory prefix assertion. | **Medium** |
| **Fastify & API** | **Denial of Service** | Resource exhaustion via excessive requests or unbounded in-memory maps. | Rate limiting active; but in-memory auth caches in `auth.ts` grow without TTL sweeps. | **Medium** |
| **Manager Approvals** | **Elevation of Privilege** | Cashier brute-forces 4-digit manager PIN to authorize discounts/voids. | Fastify rate limit applies per-caller, but no per-account lockout on the manager's PIN. | **Medium** |
| **Internal Redis** | **Elevation of Privilege** | Container escape or SSRF allows unauthenticated read/write to Redis socket. | Redis runs with no password (`requirepass` disabled). | **High** |

---

## 2. Vulnerability Findings & Risk Analysis

### [SEC-01] High: Redis Runs Without Authentication on Docker Network
- **Location**: [`docker-compose.yml:L26-29`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/docker-compose.yml#L26-L29)
- **Vulnerability**:
  ```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--save', '', '--appendonly', 'no']
  ```
- **Analysis**:
  Redis runs with default settings and no password protection. While host port 6379 is not bound to `0.0.0.0`, Redis is reachable by any container attached to the shared Docker network (`api`, `web`, `backup`, `minio`). If an attacker exploits an SSRF, a remote execution flaw in any container, or runs unauthorized code, they have unrestricted access to Redis. This allows injecting spoofed Socket.IO realtime events (`order.placed`, `bill.updated`) across the entire platform.
- **Remediation**:
  Configure a strong Redis password via environment variable and command:
  ```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD:?}', '--save', '', '--appendonly', 'no']
  ```
  Update API `REDIS_URL` in `docker-compose.yml` to `redis://:${REDIS_PASSWORD}@redis:6379`.

---

### [SEC-02] Medium: Unbounded In-Memory Caches in Authentication Layer
- **Location**: [`apps/api/src/lib/auth.ts:L50, L60`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/lib/auth.ts#L50)
- **Vulnerability**:
  ```typescript
  const cache = new Map<string, { auth: Auth; at: number }>();
  const tenantStatusCache = new Map<string, { status: string; at: number }>();
  ```
- **Analysis**:
  Entries are inserted via `cache.set(hash, ...)` upon successful token resolution. While reads verify `Date.now() - hit.at < CACHE_TTL_MS`, expired entries are never removed unless an explicit logout occurs for that token. Over prolonged service uptime in a multi-tenant platform with thousands of rotating staff sessions, guest device connections, and automated API checks, the `Map` structures will grow indefinitely, risking progressive memory bloat and Denial of Service (OOM).
- **Remediation**:
  Replace raw `Map` with a bounded LRU cache (e.g. `lru-cache` with `max: 10000, ttl: 15_000`) or implement a periodic cleanup timer:
  ```typescript
  import { LRUCache } from 'lru-cache';

  const cache = new LRUCache<string, Auth>({ max: 10_000, ttl: 15_000 });
  const tenantStatusCache = new LRUCache<string, string>({ max: 5_000, ttl: 15_000 });
  ```

---

### [SEC-03] Medium: Manager Approval PIN Lacks Account Lockout
- **Location**: [`apps/api/src/modules/approvals/routes.ts:L27-34`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/modules/approvals/routes.ts#L27-L34)
- **Vulnerability**:
  Manager PIN verification relies exclusively on IP/token-level rate limiting (`max: 10, timeWindow: '1 minute'`).
- **Analysis**:
  PINs are 4 to 6 digits (10,000 to 1,000,000 combinations). A malicious or compromised cashier session with legitimate access to `/v1/approvals` can submit up to 10 PIN guesses per minute (600/hour) against a manager's phone number without locking the manager's account or triggering progressive delays. A 4-digit PIN can be systematically brute-forced over an extended period.
- **Remediation**:
  1. Implement an account-level failed attempt counter in the database (e.g. `failed_pin_attempts` and `pin_locked_until` on the `users` table).
  2. Lock out the manager's PIN for 15 minutes after 5 consecutive failed attempts, and trigger a security notification to the owner.

---

### [SEC-04] Medium: File Upload Content-Type Trust & Missing Magic Bytes Validation
- **Location**: [`apps/api/src/modules/menu/routes.ts:L356-368`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/modules/menu/routes.ts#L356-L368) and [`apps/api/src/modules/outlets/routes.ts:L228-245`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/modules/outlets/routes.ts#L228-L245)
- **Vulnerability**:
  ```typescript
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype];
  if (!ext) throw badRequest('invalid_file_type', 'Use a JPG, PNG or WebP image');
  const body = await file.toBuffer();
  ```
- **Analysis**:
  The image extension and storage logic rely solely on `file.mimetype`, which is client-supplied in the multipart header. An attacker can upload non-image content (such as HTML, SVG with embedded scripts, or polyglot files) with a forged `Content-Type: image/png`. When served via `/files/*`, browsers could potentially be coerced into MIME-sniffing or executing content under specific conditions.
- **Remediation**:
  Validate the file signature (magic bytes) of the buffer before persisting:
  ```typescript
  function validateImageMagicBytes(buffer: Buffer): 'jpg' | 'png' | 'webp' | null {
    if (buffer.length < 12) return null;
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
    // WebP: RIFF....WEBP
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  }
  ```

---

### [SEC-05] Medium: File System Path Traversal Defense Improvement
- **Location**: [`apps/api/src/lib/storage.ts:L23-27`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/lib/storage.ts#L23-L27)
- **Vulnerability**:
  ```typescript
  function safeKey(key: string): string {
    const clean = normalize(key).replace(/^([/\\])+/, '');
    if (clean.split(sep).includes('..')) throw new Error('invalid storage key');
    return clean;
  }
  ```
- **Analysis**:
  Splitting by `sep` and checking for `..` is an incomplete defense against path traversal compared to path containment verification. On different platforms, URL encodings, unicode normalizations, or alternate path separators could theoretically bypass array-splitting checks.
- **Remediation**:
  Enforce explicit path containment using `resolve`:
  ```typescript
  export function assertContainedPath(baseDir: string, userKey: string): string {
    const base = resolve(baseDir);
    const target = resolve(base, userKey);
    if (!target.startsWith(base + sep)) {
      throw new Error('Path traversal attempt detected');
    }
    return target;
  }
  ```

---

### [SEC-06] Low/Medium: Missing `@fastify/helmet` Application Security Headers
- **Location**: [`apps/api/src/app.ts:L42-55`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/api/src/app.ts#L42-L55)
- **Vulnerability**:
  The Fastify application does not register `@fastify/helmet`.
- **Analysis**:
  While Caddy sets `Strict-Transport-Security` and `X-Content-Type-Options: nosniff`, relying solely on the reverse proxy leaves requests vulnerable in multi-tier, staging, or serverless environments (e.g. Vercel deployments where Caddy is absent). Missing headers include:
  - `X-Frame-Options: DENY` (Clickjacking prevention)
  - `Content-Security-Policy`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`
- **Remediation**:
  Install `@fastify/helmet` and register it in `app.ts`:
  ```typescript
  import helmet from '@fastify/helmet';

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        scriptSrc: ["'self'"],
      },
    },
    frameguard: { action: 'deny' },
  });
  ```

---

### [SEC-07] Low: Unsigned Print Agent Installer Script
- **Location**: [`apps/web/public/agent/install.sh:L66`](file:///Users/scaletrix/Library/CloudStorage/GoogleDrive-priyesh@scaletrix.ai/My%20Drive/restaurant%20Saas/apps/web/public/agent/install.sh#L66)
- **Vulnerability**:
  ```bash
  curl -fsSL "$WEB/agent/mezmitra-agent.mjs" -o "$DIR/mezmitra-agent.mjs.new"
  ```
- **Analysis**:
  The installer downloads and executes `mezmitra-agent.mjs` directly on the local machine with systemd/LaunchAgent privileges without verifying a cryptographic hash or digital signature against a known manifest.
- **Remediation**:
  Publish a `mezmitra-agent.mjs.sha256` checksum file on the web server; download both in `install.sh` and verify integrity via `sha256sum --check` before launching the agent service.

---

## 3. Cloud Infrastructure & Posture Review (CSPM)

### 3.1 Container Security & Hardening (`docker-compose.yml`)
1. **Container Privileges**:
   - `apps/api` and `apps/web` Dockerfiles correctly define and switch to `USER node`.
   - In `docker-compose.yml`, explicit security options and resource constraints should be specified to prevent container breakout and resource starvation:
   ```yaml
   api:
     security_opt:
       - no-new-privileges:true
     cap_drop:
       - ALL
     deploy:
       resources:
         limits:
           cpus: '2.0'
           memory: 2048M
   ```
2. **Network Isolation**:
   - `postgres`, `redis`, `minio`, and `api` are properly contained on internal networks without public port bindings. Caddy is the sole ingress on `:80` and `:443`.

### 3.2 S3 & Object Storage Security
1. **Public Bucket Exposure**:
   - When using AWS S3 or MinIO, menu photos and logos must be publicly readable by guest phones, but the bucket itself must NOT allow anonymous `s3:ListBucket`.
   - **Recommended Bucket Policy**:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Sid": "AllowPublicPhotoRead",
           "Effect": "Allow",
           "Principal": "*",
           "Action": "s3:GetObject",
           "Resource": [
             "arn:aws:s3:::dineos-production/*/menu/*",
             "arn:aws:s3:::dineos-production/*/branding/*"
           ]
         }
       ]
     }
     ```
   - Ensure `BlockPublicAcls`, `IgnorePublicAcls`, and `RestrictPublicBuckets` are enforced, allowing access solely via specific object policies.

### 3.3 Database & Cloud Secret Management
1. **Secret Storage**:
   - Hardcoded database passwords in `.env.supabase.local` must remain strictly local and excluded from git (verified in `.gitignore`).
   - For AWS/GCP deployments, replace `.env.production` files with **AWS Secrets Manager** or **GCP Secret Manager**, injected dynamically at container startup.
2. **Database Backup Hardening**:
   - Backup files are encrypted using `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`.
   - AES-CBC lacks built-in authentication/integrity. While `restore.sh` optionally checks `.sha256`, the checksum verification should be made **mandatory** (aborting if the `.sha256` file is absent).

---

## 4. Remediation Roadmap

```mermaid
gantt
    title Mezmitra Security Remediation Roadmap
    dateFormat  YYYY-MM-DD
    section Critical & High
    SEC-01: Set Redis Password Authentication    :crit, p0, 2026-10-18, 1d
    section Medium Priority
    SEC-02: Bound In-Memory Auth Caches (LRU)    :p1, 2026-10-19, 2d
    SEC-03: Add Manager PIN Attempt Lockout      :p1, 2026-10-20, 2d
    SEC-04: Magic Bytes Image Validation         :p1, 2026-10-21, 1d
    SEC-05: Strict Storage Path Containment Check:p1, 2026-10-22, 1d
    section Low Priority / Hardening
    SEC-06: Register @fastify/helmet Security Headers :p2, 2026-10-23, 1d
    SEC-07: Docker Hardening (cap_drop & limits)      :p2, 2026-10-24, 1d
    SEC-08: Agent Installer Checksum Verification    :p2, 2026-10-25, 1d
```

### Remediation Checklist

- [x] **[P0] SEC-01**: Add `requirepass` to `docker-compose.yml` Redis service and update `REDIS_URL`.
- [x] **[P1] SEC-02**: Install `lru-cache` in `apps/api` and replace unbound `Map` instances in `src/lib/auth.ts`.
- [x] **[P1] SEC-03**: Add failed PIN attempts counter and 15-minute temporary lockout in `approvals/routes.ts`.
- [x] **[P1] SEC-04**: Add buffer magic bytes check in `menu/routes.ts` and `outlets/routes.ts`.
- [x] **[P1] SEC-05**: Replace substring-based path traversal check in `storage.ts` with `resolve()` boundary containment.
- [x] **[P1] SEC-06**: Install `@fastify/helmet` in `apps/api` and register with default strict security headers.
- [x] **[P2] SEC-07**: Add `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and CPU/Memory limits to `docker-compose.yml`.
- [x] **[P2] SEC-08**: Update `install.sh` to fetch and verify SHA-256 checksum of `mezmitra-agent.mjs`.

### Remediation status (October 2026)

Every finding was checked against the code before fixing; all were confirmed except SEC-02, which was already half fixed.

| Finding | What changed | Where |
| :--- | :--- | :--- |
| SEC-01 Redis without auth | `--requirepass` from the required `REDIS_PASSWORD`; the API connects with it. Redis also runs as its own user with a memory cap. MinIO (same class of issue: it fell back to a known password) moved to `docker-compose.s3.yml`, which refuses to start without real credentials. | `docker-compose.yml`, `docker-compose.s3.yml`, `.env.production.example` |
| SEC-02 Unbounded auth caches | Expired entries were already swept every 15 s. Both caches now use a small TTL cache with a hard size cap (20,000 sessions, 10,000 tenants). No new dependency. | `apps/api/src/lib/ttl-cache.ts`, `lib/auth.ts` |
| SEC-03 Manager PIN guessing | Five wrong PINs in a row lock that manager's PIN for 15 minutes, counted on the manager (not per IP or device) and committed even though the request fails. The owner gets a phone alert and an on-screen notice, and the lock is in the audit log. A right PIN resets the count; setting a new PIN lifts a lock. Unknown logins cost the same time as known ones. | `modules/approvals/routes.ts`, migration `0022` |
| SEC-04 Upload type trust | The type comes from the file's first bytes (JPEG, PNG, WebP); the client's Content-Type and name are ignored for both menu photos and logos. | `apps/api/src/lib/images.ts` |
| SEC-05 Path containment | Keys must match a strict shape and the resolved path must sit inside the storage folder. `/files/*` serves only image types, with `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. | `apps/api/src/lib/storage.ts` |
| SEC-06 Security headers | Set on every response (including errors): `nosniff`, `X-Frame-Options: DENY`, a no-script CSP with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, COOP, CORP `same-site` (`cross-origin` for images), Permissions-Policy, and HSTS in production. Written as a hook rather than `@fastify/helmet`, whose default `Cross-Origin-Resource-Policy: same-origin` would block menu photos when the web app is on another subdomain. Caddy now also sends HSTS for the web domain. | `apps/api/src/lib/security-headers.ts`, `infra/caddy/Caddyfile` |
| SEC-07 Container hardening | `no-new-privileges` everywhere; `cap_drop: [ALL]` for api, web, migrate, backup, redis and caddy (which keeps only `NET_BIND_SERVICE`); CPU and memory limits. Postgres keeps its entrypoint's capabilities (it drops to the postgres user itself). | `docker-compose.yml` |
| SEC-08 Installer integrity | The build publishes `mezmitra-agent.mjs.sha256`. Both installers verify the download before replacing the running agent, and accept only HTTPS addresses. The checksum catches damaged or wrong downloads; authenticity rests on the site's HTTPS. | `apps/print-agent/scripts/publish-download.mjs`, `apps/web/public/agent/install.*` |
| 3.2 Bucket exposure | Documented: object policies for the photo folders only, no anonymous listing, Block Public ACLs on, and never `mc anonymous set download` on the whole bucket. | `docs/operations.md`, Object storage |
| 3.3 Backup integrity | Backups are signed with HMAC-SHA256 under a key derived from `BACKUP_PASSPHRASE`, so a swapped file with a fresh checksum is caught. `restore.sh` refuses anything it cannot verify; older checksum-only backups need `ALLOW_UNSIGNED_BACKUP=yes`. | `infra/backup/backup-mac.sh`, `backup.sh`, `restore.sh` |

Tests: `apps/api/test/security.test.ts` (PIN lockout, upload content checks, storage containment, headers, cache bounds), plus the existing suites.

---

## 5. Conclusion

Mezmitra possesses a **solid, well-architected security core**—especially regarding multi-tenant RLS isolation, domain-separated cryptographic tokens, and on-premise camera privacy protection. Implementing the remediations above—primarily securing the internal Redis instance, bounding memory caches, and locking down PIN attempts—will elevate the platform to institutional enterprise standards.
