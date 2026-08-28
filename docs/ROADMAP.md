# SWITCHBOARD Development Roadmap

The roadmap follows the physical vertical slice. A milestone is complete only
when its backing behavior works; interface presence alone does not count.

## Batch 0 — Foundation — v0.1.x

**Status: complete**

- Repository structure and version source
- Workbench shell and responsive Field Instrument visual system
- Flasher, protocol, and board-profile boundaries
- Documentation, packaging, and tests

## Batch 1 — Device Model — v0.2.x

**Status: complete in v0.2.0**

- Persistent device registry
- Board-profile validator and loader
- Complete UNO R4 WiFi profile
- Server-side device simulator
- Genuine online, offline, reconnecting, and unknown states
- Groups, labels, non-secret configuration import/export, and connection history
- Persistent SQL schema and generated forward migration

## Batch 2 — Transport — v0.3.x

**Status: complete in v0.3.0**

- Authenticated device WebSocket endpoint
- One-time enrollment token exchange
- Individually revocable device credentials
- Heartbeat, bounded reconnection, snapshots, and browser live updates

## Batch 3 — General-Purpose Input/Output — v0.4.x

**Status: complete in v0.4.0**

- Digital pin mode and state
- Output write with acknowledgment and timeout
- Requested-versus-confirmed model
- Labels, logical states, and hardware command audit

## Batch 4 — UNO R4 WiFi Agent — v0.5.x

**Status: implementation complete in v0.5.0; physical HIL acceptance pending**

- Manual UNO R4 WiFi agent source and pinned toolchain
- One-time enrollment, permanent authentication, heartbeat, and bounded reconnection
- Safe-input boot, digital input/output acknowledgments, snapshots, and redacted logs
- Operator-recorded Hardware-in-the-Loop (HIL) evidence with a 1,000-cycle gate

The source and validation workflow are ready, but the milestone is not accepted
until a physical board completes every HIL step with zero cycle failures. The
community server isolates public device traffic from owner-gated operator
routes; production access activation and physical validation remain.

## Batch 5 — Browser Provisioning — v0.6.x

**Status: browser provisioning implemented in v0.6.0; erase/write activation blocked by Batch 4 HIL**

- Web Serial detect and runtime/bootloader identity — implemented
- Candidate firmware manifest and source integrity verification — implemented
- Board-specific SAM-BA reset/profile boundary — implemented; erase/write engine gated
- Wi-Fi provisioning, enrollment wizard, and USB recovery — implemented

This release deliberately publishes no binary and cannot erase the board. A
known-good package requires a reproducible compile, matching digest, and a
passing physical HIL record before the browser write engine can be activated.

## Batch 6 — Analog and Pulse Width Modulation — v0.7.x

**Status: application and source contracts complete in v0.7.0; physical agent validation pending**

- Analog input and engineering scaling — implemented
- Pulse Width Modulation (PWM) and Digital-to-Analog Converter (DAC) — implemented with acknowledgment
- Server telemetry with sample and retention limits — implemented
- Live charts and history export — implemented

The simulator and server contracts are verified. The physical v0.7 agent source
remains a candidate until it compiles reproducibly and the Batch 4 HIL procedure
passes on a board; Batch 6 does not relax that release gate.

## Batch 7 — Device Workbench — v0.8.x

**Status: application and source contracts complete in v0.8.0; physical agent validation pending**

- Complete interactive board visualization — implemented
- Pin inspector, serial console, agent logs, and device details — implemented
- Maintenance Mode and Monitor Only lock — implemented
- Server-commanded and firmware-local safe-state distinction — implemented

The server safe-state profile is a set of acknowledged remote commands, not an
autonomous failsafe or an atomic hardware transition. The candidate firmware
reports safe-input boot and no link-loss timer. It still needs reproducible
compilation and the Batch 4 physical HIL pass; Batch 7 does not relax that gate.

## Batch 8 — Automation — v0.9.x

**Status: application and simulator contracts complete in v0.9.0; durable
scheduler and physical automation validation pending**

- Structured persisted rules and revisions — implemented
- Revision advancement on every definition, mode, fallback, and archive
  transition — implemented
- Fresh-sample thresholds, hysteresis, `FOR` duration, and stale-data reset — implemented
- Best-effort activity-driven intervals and UTC schedules — implemented
- One bounded absolute digital, PWM, or DAC action with cross-device targets — implemented
- Explicit dry-run and live modes with persistent evidence — implemented
- Device arming, simulator/physical scope, configuration fencing, cooldowns,
  rate limits, active-run suppression, and loop protection — implemented

Threshold evaluation runs on newly accepted device state. Interval and schedule
checks run during device heartbeat or command-poll traffic, or while a simulator
is ticked. The community runtime has no durable scheduled
handler, so v0.10.0 does not claim unattended cron delivery: a due occurrence can
wait for activity and missed occurrences are not replayed.

Simulator actions are covered by the Batch 8 contracts. Physical rules remain
disabled unless the target is explicitly armed, the rule has physical-control
scope, and every physical source and target has a current passing HIL record.
Current means the record's pass-bound device configuration version and
start-captured reported agent and firmware versions still match. No physical
automation run has been accepted, and the unchanged v0.8.0 firmware candidate
still reports no link-loss timer. Batch 8 is not a real-time or safety-rated
controller and does not relax any earlier physical release gate.

## Batch 9 — Community Runtime — v0.10.x

**Status: complete in v0.10.0**

- Independent Node.js HTTP and Device Protocol 1 WebSocket runtime
- SQLite adapter, forward migration ledger, and persistent Docker volume
- One-time local owner bootstrap and database-backed sessions
- Exact public device ingress with local operator gating
- Caddy automatic HTTPS, health checks, backup helper, and community documentation

The hosted production lineage remains separate. Community installations use
their own database, secrets, DNS, and repository remote.

## Batch 10 — Firmware Management — v0.11.x

- Firmware repository and manifests
- Version comparison and integrity checks
- USB update workflow
- Over-the-Air (OTA) architecture without claiming unsupported delivery

## Batch 11 — Administration — v0.12.x

- Administrator, Operator, and Viewer roles
- Application Programming Interface (API) and scoped tokens
- Database backup/restore, diagnostic export, and server health
- Global telemetry retention and storage limits

## Batch 12 — Reliability — v0.13.x

- 24-hour soak and repeated General-Purpose Input/Output (GPIO) command tests
- Router, server, device, and browser restart recovery
- Concurrent user, schema migration, permission, and security tests

## Batch 13 — UNO R4 WiFi 1.0

- Stable protocol and database schema
- Stable UNO R4 WiFi board profile, agent, and browser flashing package
- Easy Mode and Advanced Mode cleanup
- Complete deployment, recovery, and security documentation

Additional board families begin only after the UNO R4 WiFi 1.0 criteria pass.
