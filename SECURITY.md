# Security Policy

## Supported release

Security fixes target the newest SWITCHBOARD Community release. This project is
pre-1.0; upgrade notes may include schema and deployment changes.

## Reporting a vulnerability

Use the repository host's private security-advisory feature when available. Do
not open a public issue containing credentials, private device data, exploit
details, or an internet-reachable installation address. Include the affected
version, deployment topology, reproduction steps, and impact without real secrets.

## Deployment responsibility

Operators are responsible for host patching, DNS, firewall rules, trusted TLS,
backups, physical device safety, and access to `.env` and the SQLite volume.
Review `docs/deployment.md` before exposing a server or attaching real loads.

SWITCHBOARD is not a safety-rated controller. The server safe-state feature is a
remote command sequence and cannot replace local electrical protection,
interlocks, watchdogs, or a firmware link-loss failsafe.
