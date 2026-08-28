# Community Deployment and Security Checklist

## Supported topology

The supplied deployment has one public Caddy service and one private application
service. Caddy terminates TLS and proxies HTTP and WebSocket traffic to the Node
server. The Node server owns request authentication, exact device-route exposure,
trusted client-address stamping, migrations, and SQLite access.

Use a dedicated hostname. Path-prefix deployment is not supported in v0.10.0.

## Before first start

1. Install current Docker Engine and the Compose plugin.
2. Create a DNS A/AAAA record for the chosen hostname.
3. Permit inbound TCP 80 and TCP/UDP 443; do not publish app port 3000.
4. Copy `.env.example` to `.env`.
5. Generate at least 32 random bytes with `openssl rand -hex 32` and store the
   result as `SWITCHBOARD_BOOTSTRAP_TOKEN`.
6. Set `SWITCHBOARD_SITE_ADDRESS` to the hostname and
   `SWITCHBOARD_PUBLIC_URL` to its `https://` URL.
7. Start with `docker compose up -d --build` and wait for both services to be healthy.
8. Complete `/setup` once. Confirm a second setup attempt is rejected.

Do not place `.env`, SQLite files, cookies, Wi-Fi passwords, enrollment tokens,
or permanent device credentials in issue reports or diagnostic archives.

## Operator boundary

- Passwords are hashed with scrypt and a random per-password salt.
- Browser sessions use random opaque tokens; only SHA-256 hashes are stored.
- Cookies are HttpOnly, SameSite=Strict, scoped to `/`, expire after seven days,
  and gain `Secure` when the original request is HTTPS.
- The server strips inbound operator identity and trusted-address headers.
- Browser requests with a conflicting `Origin` are rejected for unsafe methods.
- Login and setup attempts have persistent per-client fixed-window limits.
- Setup requires the environment bootstrap token and is disabled after the
  singleton installation record exists.

The initial release exposes one owner account. Although the database reserves
role values, multiple users and role-specific authorization are not supported.

## Device boundary

The anonymous device surface is exactly:

- `POST /api/device-enrollment/exchange`
- WebSocket upgrade `GET /api/device/socket`

Enrollment tokens are one-time, short-lived, and stored as hashes. Device
credentials are returned only once and stored as hashes. Credentials are checked
at authentication and before every subsequent socket message. Revocation closes
the server-side session state and prevents new work from being claimed.

Production boards must use HTTPS/WSS with a certificate chain trusted by their
connectivity module. Never use `--insecure` across an untrusted network.

## Reverse proxy boundary

The Compose network is designed so only Caddy can reach the app. Keep
`SWITCHBOARD_TRUST_PROXY=true` only in that topology. If deploying differently:

- strip inbound `x-switchboard-authenticated-user-email`,
  `x-switchboard-authenticated-user-role`, and
  `x-switchboard-client-address` headers;
- preserve the original host and protocol;
- support WebSocket upgrades and connections longer than the 35-second session timeout;
- do not log enrollment bodies, cookies, or authorization material;
- apply body and connection limits without breaking the 2 KiB enrollment request.

## Database and migrations

SQLite uses foreign keys, WAL journal mode, a five-second busy timeout, and one
application process. Do not run multiple app replicas against the same database
file or a network filesystem.

On startup, the server creates a migration ledger and applies unapplied files in
`drizzle/` in lexical order inside transactions. Back up before upgrading. Never
rename, remove, or rewrite an applied migration.

Run `./scripts/backup.sh` for a consistent closed-database copy. Validate restore
procedures on a separate server, including operator login, device records,
credential revocation, and migration startup.

## Hardware control boundary

An online physical device is not control-ready until a complete current-session
snapshot is accepted. Output state changes only after an exact device
acknowledgment. Maintenance Mode and Monitor Only block hardware-changing
commands. Queued commands time out and remain in the audit ledger.

The server safe-state profile is a sequence of remote commands, not an atomic or
autonomous failsafe. It cannot protect hardware after communication loss. The
current candidate firmware reports safe-input boot but no link-loss timer.

Automation is activity-driven: threshold rules evaluate on accepted state;
interval and UTC schedule rules are checked during board or simulator activity.
This release has no durable scheduler and makes no real-time, watchdog, or
safety-controller guarantee. Physical automation remains behind current HIL
evidence and explicit arming.

## Upgrade checklist

1. Create and verify a backup.
2. Read `CHANGELOG.md` and inspect new migrations.
3. Pull or unpack the new release into a clean directory.
4. Preserve `.env` and the named data volumes; do not copy build artifacts.
5. Run `docker compose up -d --build`.
6. Confirm `/health/ready`, owner login, registry data, and one simulator action.
7. Confirm a test board reconnects before returning production loads to service.

## Incident response

- Lost board: revoke its credential, inspect session/command history, then reprovision.
- Exposed enrollment token: revoke it if unused; used tokens cannot be replayed.
- Suspected owner session exposure: sign out, rotate the bootstrap environment
  secret for future recovery policy, and inspect access logs. Password rotation
  is not exposed in v0.10.0; isolate the service and replace the owner hash only
  through a reviewed migration or a future supported administration release.
- Database exposure: treat operator hashes, device credential hashes, operational
  metadata, and telemetry as compromised; rotate/reprovision devices and rebuild
  the operator installation on a clean database.

## Required warnings

- SWITCHBOARD is not a safety-rated controller.
- Do not expose port 3000 directly when proxy trust is enabled.
- Do not expose operator APIs as anonymous device endpoints.
- Do not connect real loads before physical HIL acceptance.
- Do not claim unattended schedule execution in this release.
