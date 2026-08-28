# SWITCHBOARD Community

**Self-hosted microcontroller command workbench — v0.10.0**

SWITCHBOARD Community provisions, monitors, and controls network-capable
microcontrollers from a browser. This repository is the portable, independent
self-hosted edition: Node.js serves the Next.js workbench and Device Protocol 1
WebSocket gateway, SQLite stores durable state, and Caddy provides HTTPS.

The first supported physical profile is the Arduino UNO R4 WiFi. The included
simulator lets you explore the full workbench without hardware.

## What is included

- Persistent device registry, groups, pin configuration, connection history,
  telemetry, logs, and command evidence
- One-time device enrollment and individually revocable device credentials
- Authenticated device WebSockets with bounded messages, heartbeat expiry, and
  credential checks on every message
- Digital, PWM, DAC, and analog workbench behavior with requested-versus-confirmed
  state and command timeouts
- Maintenance Mode, Monitor Only, server safe-state profiles, and Hardware-in-the-Loop evidence
- Structured dry-run/live automation with revisions, limits, and audit records
- One-time owner bootstrap, scrypt password hashing, hashed opaque sessions, and sign-out
- Automatic forward SQLite migrations, readiness/liveness endpoints, Docker Compose,
  and Caddy HTTPS/WebSocket proxying

## Quick start with Docker

Requirements: Docker Engine with the Compose plugin, and free host ports 80 and
443. For a public install, point a DNS A/AAAA record at the server first.

```bash
cp .env.example .env
openssl rand -hex 32
```

Paste the generated value into `SWITCHBOARD_BOOTSTRAP_TOKEN` in `.env`.

For local use, leave these defaults:

```dotenv
SWITCHBOARD_SITE_ADDRESS=http://localhost
SWITCHBOARD_PUBLIC_URL=http://localhost
```

For a public install, use a dedicated hostname:

```dotenv
SWITCHBOARD_SITE_ADDRESS=switchboard.example.com
SWITCHBOARD_PUBLIC_URL=https://switchboard.example.com
```

Then start the stack:

```bash
docker compose up -d --build
docker compose ps
```

Open the configured URL, enter the bootstrap token, and create the owner. Setup
is permanently disabled after that transaction succeeds. Keep `.env` private.

For HTTPS, Caddy must be reachable from the internet on TCP 80 and TCP/UDP 443.
The app container is not published directly by the supplied Compose file.

> Path-prefix hosting such as `example.com/switchboard` is not supported in this
> release. Use a dedicated hostname such as `switchboard.example.com`; this also
> keeps firmware endpoint configuration simple and portable.

## Native Node.js install

Node.js 22.13 or newer is required.

```bash
npm ci
cp .env.example .env
npm run build
set -a && . ./.env && set +a
npm start
```

The native server defaults to `0.0.0.0:3000` and
`./data/switchboard.db`. Put a TLS reverse proxy in front of it before connecting
real devices over the internet. Set `SWITCHBOARD_TRUST_PROXY=true` only when the
app port is reachable exclusively through a trusted proxy.

## Connect an Arduino UNO R4 WiFi

1. In SWITCHBOARD, open **Transport** and create a short-lived enrollment token.
2. Install the pinned Arduino toolchain and compile the canonical sketch:

   ```bash
   ./scripts/setup-firmware-toolchain.sh
   ./scripts/build-firmware.sh
   ```

3. Upload `firmware/uno-r4-wifi/SwitchboardAgent/SwitchboardAgent.ino` with the
   Arduino IDE or `arduino-cli`.
4. Provision Wi-Fi and the server hostname over USB:

   ```bash
   python3 -m pip install pyserial
   ./scripts/provision-agent.py \
     --port /dev/ttyACM0 \
     --ssid YourWiFi \
     --server-host switchboard.example.com \
     --enrollment-token 'swenr_…'
   ```

The script prompts for the Wi-Fi password without echoing it. Use `--insecure`
only for isolated plaintext local development. The firmware stores its permanent
device credential in EEPROM; revoke and reprovision after loss or reassignment.

The agent remains a physical-validation candidate. Read
[`firmware/uno-r4-wifi/README.md`](firmware/uno-r4-wifi/README.md) and
[`docs/hardware-in-the-loop.md`](docs/hardware-in-the-loop.md) before attaching
loads. SWITCHBOARD is not a safety-rated controller.

## Operations

Health endpoints:

- `GET /health/live` confirms the Node process is serving.
- `GET /health/ready` confirms SQLite is queryable.

Persistent data is stored in the `switchboard-data` Docker volume at
`/data/switchboard.db`. Caddy certificates and state use separate volumes.

Create a consistent SQLite backup with:

```bash
./scripts/backup.sh
```

The script briefly stops only the app container, copies the closed database into
`./backups`, and restarts the app. Test restoration on a separate installation
before relying on a backup procedure.

Upgrade a checkout with:

```bash
git pull --ff-only
docker compose up -d --build
```

The server applies unapplied forward migrations in filename order at startup.
Never edit a migration that has already run on an installation.

## Security boundary

Only these board-facing routes are anonymous:

- `POST /api/device-enrollment/exchange`
- `GET /api/device/socket` as a WebSocket upgrade

Enrollment is JSON-only and capped at 2 KiB. Socket messages are capped at
32 KiB and must authenticate within five seconds. Fixed-window client and global
rate limits are stored without raw client addresses. Every other operator API and
page requires a valid local session. The community server strips inbound
identity headers before injecting its own authenticated identity.

The current setup creates one owner. Role values are reserved in the schema, but
multi-user administration is not exposed yet. Do not create database users by
hand and assume role separation is enforced.

See [`docs/deployment.md`](docs/deployment.md) for the production checklist and
[`SECURITY.md`](SECURITY.md) for disclosure and hardening guidance.

## Development

```bash
npm ci
npm run dev
npm run lint
npm test
```

`npm test` performs a production build before running the migration, registry,
gateway, GPIO, telemetry, automation, provisioning, and interface contracts.

Database schema changes:

```bash
npm run db:generate -- --name descriptive_change
```

Inspect the generated SQL before committing it.

## Architecture

| Component | Community implementation |
|---|---|
| Browser workbench | Next.js App Router / React |
| Operator boundary | Local owner password and hashed opaque session |
| Device ingress | Node HTTP + `ws`, Device Protocol 1 |
| Database | SQLite in WAL mode with ordered migrations |
| Edge TLS | Caddy automatic HTTPS and WebSocket proxy |
| Packaging | Docker Compose or native Node.js |

The Device Protocol remains version 1, so the existing UNO R4 agent and board
profile are unchanged by the hosting fork.

## License

MIT. See [`LICENSE`](LICENSE).
