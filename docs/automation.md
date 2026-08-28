# Automation Contract

SWITCHBOARD Community v0.10.0 provides a structured server-side rule engine. Rules are
persisted data, not executable JavaScript, and all live actions travel through
the same requested-versus-confirmed General-Purpose Input/Output (GPIO) command
ledger used by an operator.

This is a bounded bench-automation capability. It is not a programmable logic
controller, a real-time scheduler, a safety instrument, or firmware-local
fail-safe behavior.

## Rule lifecycle

A rule has one of three modes:

- `DISABLED`: no activity-driven evaluation occurs.
- `DRY_RUN`: activity can evaluate the rule and retain evidence, but no GPIO
  command is created.
- `LIVE`: a matching trigger can request one bounded output command after every
  admission and device guard passes.

New rules are revision 1 and disabled. Editing is refused while a rule is live.
Every persisted definition or state mutation advances the revision: saving an
edit, changing among `DISABLED`, `DRY_RUN`, and `LIVE`, an automatic fallback to
disabled after a failed live transition, and archiving. A definition edit clears
prior approval and leaves the rule disabled. A live transition first creates a
new revision, then approves only that revision and records the approving owner
and time. Revision conflicts require the operator to reload instead of
overwriting newer state.

Archiving is allowed only after a rule is disabled. It removes the rule from the
active list without converting old execution evidence into a success claim.
Automation-rule import/export is not implemented in Batch 8; no configuration
import can silently create or enable a rule.

The local authenticated owner session supplies the sole operator identity while
the two exact device routes remain publicly reachable. The stored rule permission
scope is therefore `OWNER_ONLY`; Administrator, Operator, and Viewer roles remain
a later administration milestone.

## Structured rule shape

Batch 8 accepts only documented fields. Unknown fields and script-like payloads
are rejected. A rule contains:

- name up to 80 characters and description up to 500 characters;
- one trigger;
- exactly one absolute output action;
- simulator-only or physical-control action scope;
- cooldown, execution-rate window, and causation-depth limits.

At most 50 non-archived rules are retained. The default action scope is
`SIMULATOR_ONLY`.

### Triggers

`THRESHOLD` compares the latest confirmed source-pin value using greater than,
at or above, less than, at or below, equal, or not equal. It can require:

- non-negative hysteresis;
- a `FOR` duration from zero through 24 hours; and
- a maximum sample age from 1 through 300 seconds.

The rule retains the source configuration version and, for an analog source,
the engineering unit. A changed calibration, unit, pin configuration, missing
source, offline source, unsynchronized physical session, or stale value blocks
the rule and resets its hold state. `FOR` advances across the recorded times of
fresh accepted samples, not wall-clock time alone. Once fired, a threshold stays
latched until the value crosses its hysteresis reset boundary.

`INTERVAL` accepts a period from 10 seconds through 7 days.

`SCHEDULE` accepts a minute of day and enabled-day mask in Coordinated Universal
Time (UTC). Local time zones and daylight-saving conversion are not part of the
Batch 8 contract.

### Actions

Each rule has exactly one action targeting an existing output pin:

- `WRITE` on a configured digital output with value `0` or `1`;
- `WRITE_PWM` on a configured Pulse Width Modulation (PWM) output with a 12-bit
  integer from `0` through `4095`; or
- `WRITE_DAC` on a configured Digital-to-Analog Converter (DAC) output with a
  12-bit integer from `0` through `4095`.

Automation cannot change a pin mode, toggle a relative value, change Monitor
Only or Maintenance Mode, arm another device, alter a safe-state target, issue
credentials, enroll a device, write firmware, create a Hardware-in-the-Loop
(HIL) record, call a URL, or execute a webhook. The target configuration version
is captured when the rule is saved and must still match at execution.

The source and target may be different devices. This is a cross-device command,
not an atomic distributed transaction. Batch 8 permits one action specifically
so the terminal result maps to one exact acknowledged command; later multi-action
rules must define and expose partial completion before they are enabled.

## Dry run and manual evaluation

A dry run evaluates the current trigger and records:

- rule and revision;
- source kind and deduplicated event key;
- observed value and server-recorded time, when applicable;
- hold-window state and match result;
- planned target, pin, command kind, and value; and
- the reason it matched, did not match, or was blocked.

Dry run never inserts a GPIO command, including when the target is simulated.
It is not electrical evidence and does not satisfy HIL.

Advanced Mode can request a manual evaluation of a live rule after explicit
hardware confirmation. Manual evaluation does not force an action or bypass the
trigger: the current trigger must match and all normal live guards still apply.

## Live admission and command confirmation

Live rules require:

- approval of the current revision;
- a cooldown of at least five seconds;
- a target device explicitly armed for automation;
- an unchanged target configuration;
- simulator-only scope for a simulator, or physical-control scope and a passing
  current HIL record for a physical target;
- no active execution for the same rule;
- no cooldown, execution-rate, or causation-chain block; and
- no detected static dependency cycle among live threshold rules.

Dispatch then calls the normal GPIO issue path. That path atomically rechecks
online state, a current accepted snapshot for a physical device, Maintenance
Mode, Monitor Only, current pin mode and value bounds, device automation
permission, the live approved rule revision and execution, and the absence of
another active command on the pin. The device claim path repeats the applicable
checks before a queued command can be delivered.

An automation command records origin `AUTOMATION`, actor `automation:<rule-id>`,
rule identifier and revision, action identifier, execution identifier, target,
requested value, session, acknowledgment, timing, and failure. A trigger match,
execution record, queued command, or delivered command is not confirmation.
Only the exact matching device acknowledgment changes confirmed pin state and
marks the action acknowledged.

A physical threshold source also requires a current passing HIL record. For both
physical sources and targets, current means the record belongs to that device and
its pass-bound configuration version and start-captured reported agent and
firmware versions still match the device. A configuration or reported-version
change does not rewrite the historical HIL record; it makes that record
ineligible for automation and a new physical run is required. Changing a
physical device configuration also disarms automation.

## Cooldown, rate, and loop protection

Each rule has persistent controls:

- cooldown from zero through 24 hours, with a five-second minimum for live mode;
- 1 through 60 live executions within a window of 1 minute through 24 hours;
- at most one queued or running execution for the rule;
- maximum causation-chain depth from 0 through 4;
- one execution per unique source event or schedule slot;
- direct source-to-same-pin rejection;
- static cycle rejection across live threshold rules; and
- a causal chain that refuses to revisit the same rule.

These controls reduce accidental feedback and duplicate dispatch; they cannot
prove that a physical process has no hidden feedback path. Independent hardware
interlocks remain necessary for hazardous energy, motion, heat, pressure, or
life-safety use.

Disabling a rule, changing it to dry-run mode, disarming a target device, or
enabling a device control lock cancels queued automation commands. A command
already delivered to a microcontroller cannot be recalled. The operator must
inspect its acknowledgment or timeout before assuming the hardware state.

## Activity-driven timing

The community Node runtime has no durable scheduled/cron loop.
Automation evaluation occurs during existing activity:

- an accepted physical-device snapshot evaluates threshold rules for that source;
- heartbeat and command-poll activity checks due interval and schedule rules;
- an acknowledged automation output can evaluate downstream threshold rules
  while carrying causation lineage; and
- a simulator tick evaluates its threshold rules and due timed rules.

Due interval and schedule records are claimed once. After a delayed evaluation,
the next occurrence is calculated from the current evaluation time. Missed
occurrences are not replayed as a burst. If no relevant device or simulator
activity occurs, timed rules do not run. A due occurrence may therefore be late
by an unbounded amount.

This activity-driven model is intentional and visible in the interface. It must
not be described as unattended cron, exact scheduling, real-time execution, or a
watchdog. A future durable runner needs its own deployment, idempotency, health,
restart, and missed-occurrence tests before the timing claim can change.

## Execution evidence and retention

Execution status distinguishes `NO_MATCH`, `ARMED`, `RESET`, `DRY_RUN`,
`QUEUED`, `RUNNING`, `ACKNOWLEDGED`, `PARTIAL`, `BLOCKED`, `FAILED`,
`TIMED_OUT`, `COOLDOWN`, `RATE_LIMITED`, `LOOP_BLOCKED`, and `CANCELLED`.
The action step separately records planned, dry-run, queued, delivered,
acknowledged, failed, timed-out, or cancelled state.

Execution pruning is admission-aware. It preserves at least the newest 500
records, every queued or running execution, every execution linked to a queued or
delivered GPIO command, and terminal live executions still within that rule's
cooldown or rate-limit window. The database can therefore contain more than 500
execution rows. Rule-list responses are capped at 50 and
execution-list responses at 500. This operational ledger is not an unlimited
regulatory archive. Full database backup and restore remain part of the
administration milestone.

## Trust and physical safety boundary

Device authentication proves possession of a valid device credential. It does
not prove that a sensor, calibration, wiring, load, or electrical reading is
correct. An approved cross-device rule intentionally allows one authenticated
source device to influence another armed target. A compromised or miswired
source can therefore attempt to trigger that approved action until rate, loop,
lock, or permission controls stop it.

The v0.8.0 physical agent candidate starts managed pins as inputs at boot and
reports no autonomous link-loss timer. Server automation cannot change an output
after complete communication loss and cannot force a remote safe state. Outputs
may remain in their last device state. Do not use SWITCHBOARD as the sole control
for heaters, motors, actuators, hazardous loads, machinery, or life-safety
functions. Use independent local firmware limits, physical interlocks, fuses,
contactors, emergency stops, and an appropriate safety-rated controller.

Simulator automation is covered by the v0.9.0 software contracts. Current HIL
matching is an admission interlock, not a Batch 8 physical acceptance result.
Physical automation remains a gated, unvalidated release capability until the
supplementary procedure in `docs/hardware-in-the-loop.md` passes on real
hardware and the release evidence is reviewed.
