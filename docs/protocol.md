# SWITCHBOARD Device Protocol 1

Protocol 1 is an authenticated, acknowledgment-oriented message protocol over a
secure WebSocket in production. The browser never talks directly to a deployed
device after provisioning.

## Enrollment

An operator creates an enrollment token with a device name, board profile, and a
5–60 minute lifetime. The response shows the `swenr_…` secret once. The database
stores its SHA-256 digest and a non-secret prefix, never the raw token.

The client exchanges the token over HTTPS:

```json
{
  "token": "swenr_…",
  "hardwareId": "stable-device-identifier"
}
```

`POST /api/device-enrollment/exchange` consumes the token and returns a stable
device ID, one `swdev_…` credential, the socket path, and protocol version. A
used, expired, revoked, malformed, or unknown token is rejected. The raw device
credential is also returned once and stored by the server only as a SHA-256
digest.

## Socket connection

Connect to `/api/device/socket` using secure WebSocket transport. The first
message must arrive within five seconds and must authenticate:

```json
{
  "type": "device.authenticate",
  "deviceId": "DEV-…",
  "credential": "swdev_…",
  "protocolVersion": 1
}
```

Success creates a persistent session and returns:

```json
{
  "type": "device.authenticated",
  "protocolVersion": 1,
  "sessionId": "SESS-…",
  "serverTime": 0,
  "heartbeatIntervalMs": 10000,
  "sessionTimeoutMs": 35000
}
```

Authentication failure closes with an application close code. Messages are
limited to 32 KiB, and credential revocation is rechecked before every message
after authentication.

## Heartbeats and snapshots

Send a heartbeat every ten seconds. Optional metadata is bounded before storage.

```json
{
  "type": "device.heartbeat",
  "sequence": 4,
  "rssiDbm": -54,
  "ipAddress": "192.0.2.10",
  "agentVersion": "0.8.0-device-workbench-candidate",
  "firmwareVersion": "WiFiS3-version",
  "localFailsafe": { "mode": "SAFE_INPUT_BOOT", "timeoutMs": null }
}
```

The server replies with `device.heartbeat.ack`, the sequence, and server time.
Sessions without contact for 35 seconds are marked timed out. A local fail-safe
report may be `SAFE_INPUT_BOOT` or `LINK_LOSS_SAFE_STATE` with a bounded timeout.
The current candidate reports only `SAFE_INPUT_BOOT`; it reports no link-loss
timer. This authenticated metadata becomes a last report when the device is
offline and is not physical HIL evidence.

A reconnecting client sends a complete state snapshot before treating local pin
state as synchronized:

```json
{
  "type": "device.snapshot",
  "sequence": 5,
  "pins": [
    { "pinId": "D7", "mode": "OUTPUT", "value": 1 },
    { "pinId": "A0", "mode": "ANALOG", "value": 6848 }
  ]
}
```

Snapshots must contain the exact complete, unique set of profile pins and fit a
16 KiB normalized payload.
Reported modes must be valid for the profile. A snapshot cannot overwrite the
requested-versus-confirmed state of a pin with a live queued or delivered GPIO
command. The `(sessionId, sequence)` pair is unique. Success returns
`device.snapshot.ack`; invalid snapshots return `device.error` without changing
unknown pins. A physical session starts with `controlReady=false`. Acceptance of
its complete snapshot makes control ready; disconnect, timeout, or credential
revocation recomputes readiness from the remaining connected sessions. A command
poll can claim work only for a connected, active-credential session that has an
accepted snapshot. The v0.8 candidate waits for the snapshot acknowledgment
before polling.

For UNO R4 WiFi analog pins, `value` is a raw 14-bit Analog-to-Digital
Converter (ADC) integer from 0 through 16383. The server stores the raw count,
its 0–5 V conversion, and an optional two-point engineering conversion. It
accepts at most one stored sample per device pin per second and retains the
newest 720 samples for that pin. Normalized snapshot audit payloads include both
the engineering `value` and `rawValue` for analog pins.

## Reconnection

The browser view uses a finite 1, 2, 4, 8, 8 second retry schedule and then
stops. The physical agent doubles its Wi-Fi and socket retry interval up to 60
seconds and keeps recovering without an unbounded interval. Commands are not
queued indefinitely while offline. A new socket must authenticate again, and a
fresh snapshot is required before considering pin state current.

## Browser live updates

The workbench listens to the selected device's server-sent event stream. It
receives current transport bundles and heartbeat events, then reconnects using
the same bounded retry schedule. This is an operator view; it does not reveal
raw enrollment or device credentials.

## Acknowledged GPIO commands

The operator requests a digital, Pulse Width Modulation (PWM), or
Digital-to-Analog Converter (DAC) output write, or a supported pin-mode change.
The server validates online and control-ready state, Maintenance Mode, Monitor
Only, board-profile capability, current pin mode, and value, then stores a
`QUEUED` command with a bounded deadline. The same state and session predicates
are rechecked atomically when work is claimed. Only one queued or delivered
command may target a pin at a time.

An authenticated device asks for work:

```json
{ "type": "device.command.poll" }
```

The server atomically claims the oldest queued command for that device and may
return one command:

```json
{
  "type": "gpio.command",
  "commandId": "CMD-…",
  "kind": "WRITE",
  "pinId": "D7",
  "requestedMode": null,
  "requestedValue": 1,
  "deadlineAt": 0
}
```

`kind` is `WRITE`, `WRITE_PWM`, `WRITE_DAC`, or `SET_MODE`. Digital writes accept
only `0` or `1`. PWM and DAC writes accept only 12-bit integers from `0` through
`4095` and require the pin to be in the corresponding mode. Mode changes accept
`INPUT`, `INPUT_PULLUP`, `OUTPUT`, `ANALOG`, `PWM`, or `DAC` only when the board
profile exposes the matching capability. A poll with no available command has
no response.

After applying the requested change, the device reports its observed state:

```json
{
  "type": "gpio.ack",
  "commandId": "CMD-…",
  "pinId": "D7",
  "confirmedMode": "OUTPUT",
  "confirmedValue": 1,
  "deviceTimestampMs": 0
}
```

The server accepts the acknowledgment only from the session that received the
command and only when the command ID, pin, requested mode or value, and deadline
all match. It returns `gpio.ack.accepted` with `ACKNOWLEDGED` or `FAILED`.
Successful acknowledgment is the only command path that changes confirmed pin
state. A device rejection may include a bounded `error` string.

The durable lifecycle is `QUEUED` → `DELIVERED` → `ACKNOWLEDGED`, `FAILED`, or
`TIMED_OUT`. A disconnect requeues a still-valid delivered command; a late,
missing, rejected, or mismatched acknowledgment never overwrites the last
confirmed state. Requested state remains visible separately while a command is
active.

The command origin is `OPERATOR`, `SERVER_SAFE_STATE`, or `AUTOMATION`.
Automation commands additionally retain the exact rule identifier and revision,
action identifier, and execution identifier. The device receives the same
bounded `gpio.command` shape regardless of origin; it never receives or executes
rule code. Exact acknowledgment rules do not change for automation.

## Control locks

Monitor Only is a persistent server policy: reads, snapshots, telemetry, logs,
and details continue while hardware-changing requests are rejected. Maintenance
Mode enables Monitor Only. Leaving Maintenance Mode keeps Monitor Only enabled
until an operator deliberately re-arms control. Enabling either lock fails
queued commands and is refused while a delivered command remains in flight.

## Server-commanded safe-state runs

Each output, PWM, or DAC pin may have a non-secret server safe-state target:
digital `0` or `1`, or a 12-bit integer from `0` through `4095`. Applying the
profile creates one aggregate run and one normal acknowledged command per
configured target. Each command records origin `SERVER_SAFE_STATE`, the run ID,
actor, value, status, and exact acknowledgment. The aggregate succeeds only when
every target is acknowledged.

The profile requires an online, control-ready, unlocked device. A failed or
timed-out run may leave partially changed hardware, so operators must inspect
the per-command audit. It is not an atomic physical transition, cannot run after
communication loss, and is not a substitute for firmware-local behavior.

## Server-side automation

Automation is an operator/server contract layered above Device Protocol 1. A
rule is structured persisted data with one threshold, interval, or Coordinated
Universal Time (UTC) schedule trigger and exactly one absolute digital, Pulse
Width Modulation (PWM), or Digital-to-Analog Converter (DAC) output action.
Unsupported fields and executable code are rejected. Devices cannot create,
edit, approve, enable, or directly invoke rules.

Every persisted rule mutation advances its optimistic revision. Definition
updates, transitions among disabled, dry-run, and live modes, automatic fallback
to disabled after a failed live transition, and archive each require the current
expected revision and publish a new one. Live approval is bound to the revision
created by the live state transition; an older revision cannot dispatch.

Threshold evaluation reads confirmed server state from accepted snapshots. A
physical source must be online, control-ready, and covered by a current passing
HIL record. The stored source configuration version and analog engineering unit
must still match, and the sample must be within the configured age limit. `FOR`
duration is measured between fresh server-recorded samples; false, stale,
missing, disconnected, or reconfigured input clears the condition window. After
firing, hysteresis must reach its reset boundary before the rule can fire again.

Each live target must be explicitly armed for automation. Physical targets also
require physical-control rule scope and a current passing Hardware-in-the-Loop
(HIL) record. For both source and target, the HIL record's start-captured agent
and firmware versions and its configuration version bound at pass must match the
current device. The GPIO issue and claim operations recheck the live approved
rule revision, its active execution, device permission, online/control-ready
state, the polling session's accepted snapshot, Maintenance Mode, Monitor Only,
pin mode/value, and pending-pin state. Guarded dispatch separately rechecks the
target configuration revision immediately before requesting the command.

Live executions use persistent cooldown, rate-window, active-run, unique-event,
static-cycle, and causal-chain limits. Dry-run executions retain trigger evidence
and the planned action but create no GPIO command. A live execution is successful
only after its linked command is acknowledged; a trigger match, queue, or delivery
is not success.

Threshold rules run when a new device snapshot or simulator state is accepted.
Due interval and schedule rules are checked during heartbeat, command-poll, or
simulator activity. The community Node runtime has no
durable scheduled handler. Timed execution is therefore best-effort and
activity-driven, due work can be late, and missed occurrences are not replayed.
No exact, real-time, watchdog, or unattended-cron behavior is part of Device
Protocol 1.

An acknowledged automation output may evaluate downstream threshold rules with
root execution, parent execution, and depth lineage. Direct self-targets and
obvious cycles among live threshold rules are rejected; causal depth and repeated
rule visits are bounded at runtime. This does not prove that an external physical
process has no hidden feedback path.

Execution pruning keeps the newest 500 records but may preserve more. Queued or
running work, executions linked to queued or delivered commands, and live
terminal executions still within the rule's cooldown or rate-limit window remain
available for command and admission decisions. The execution-list API still
returns at most 500 records. This retention behavior is not an unlimited audit
archive.

## Safe agent logs

An authenticated device may send bounded operational events:

```json
{
  "type": "device.log",
  "level": "WARN",
  "code": "WIFI_DISCONNECTED",
  "message": "Retrying with bounded backoff",
  "deviceUptimeMs": 42000
}
```

Levels are `INFO`, `WARN`, and `ERROR`. Codes and messages are length-limited,
control whitespace is normalized, and credential-shaped values are redacted
again by the server. Storage retains only the latest 500 records per device;
searchable/filterable view and CSV export responses return at most 200. CSV
cells that could execute as spreadsheet formulas are neutralized. Success
returns `device.log.ack`. Logs must
describe events, never configuration payloads, SSIDs/passwords, enrollment
tokens, or permanent credentials.

The USB console is separate and browser-local. It keeps a bounded display ring,
redacts credential-shaped output, permits only `status` and `identify`, and does
not upload or persist console bytes as device logs.

## Security boundary

- Enrollment tokens are short-lived, single-use bootstrap credentials.
- Device credentials are individually revocable.
- Raw secrets do not appear in lists, logs, device details, diagnostics, or
  configuration exports.
- Automation rules contain bounded structured device, pin, comparator, timing,
  and numeric action data only; they cannot execute scripts or outbound URLs.
- The current rule permission is owner-only plus explicit per-device arming.
  Application Administrator, Operator, and Viewer roles are not implemented.
- Authenticated device state is a credential-bound report, not proof of sensor or
  electrical truth. Cross-device rules deliberately extend the impact of a
  trusted source and must be independently rate- and hardware-limited.
- Production device credentials require HTTPS and secure WebSockets.
- The community server admits anonymous traffic only to one-time enrollment
  exchange and the authenticated device WebSocket. Workbench and operator API
  routes require a valid local owner session.
- External hardware connects to the configured public TLS hostname on port 443
  through the supplied Caddy reverse proxy.

See `docs/automation.md` for the complete rule, timing, execution, and physical
safety contract.
