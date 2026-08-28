# Arduino UNO R4 WiFi Hardware-in-the-Loop Test

This is the Batch 4 acceptance procedure for agent
`0.8.0-device-workbench-candidate` (earlier candidates remain compatible with
the core digital procedure).
The Browser Provisioning workbench stores operator-attested evidence; it does not make
automatic electrical measurements.

## Safety and fixture

- Use only board-supported voltage levels and disconnect power before wiring.
- Never connect two pins configured as outputs.
- With the board unpowered, connect D7 directly to D2. D7 is the only driver;
  D2 must remain an input. Connect fixture ground where external instruments require it.
- Keep external loads disconnected during this loopback test.

## Setup

1. Install the pinned toolchain and compile the agent.
2. Flash it manually over USB.
3. Generate a 15-minute token and provision a TLS device endpoint over serial.
4. Confirm the resulting physical device is online and reports agent v0.8.x.
5. Open Provisioning, select the device, and start a HIL run.

Starting the run captures the device's reported agent and firmware identities
and records its current configuration version provisionally. The agent and
firmware identities remain fixed for the run. The configuration binding is
finalized only if the run reaches the pass gate, because the procedure's mode
changes can legitimately advance that version.

Use the configured public TLS hostname as the device endpoint. The community
server exposes only enrollment exchange and the secure device socket to
anonymous traffic, with persistent rate limits and a 2 KiB enrollment request
limit. Workbench and operator API traffic requires a local owner session.

## Required evidence

Record an observation for each workbench step:

1. One-time enrollment token exchanged and erased.
2. Permanent credential authenticated.
3. Board restart leaves all managed pins in safe input mode.
4. Set D2 to input and D7 to output; command D7 HIGH and verify electrically.
5. Confirm a fresh snapshot reports D2 HIGH.
6. Command D7 LOW and verify electrically.
7. Confirm a fresh snapshot reports D2 LOW.
8. Repeat the HIGH/LOW command-and-acknowledgment loop for at least 1,000 cycles.
9. Interrupt and restore Wi-Fi; record recovery time.
10. Restart and restore the device server; record recovery time.
11. Restart the board; verify safe boot, authentication, and state recovery.
12. Restart the browser; verify it resumes from server state.
13. Confirm every reconnect produces a fresh full snapshot.
14. Inspect serial and stored agent logs for Wi-Fi passwords, enrollment tokens,
    and permanent credentials.

## Pass gate

The server marks a run `PASSED` only when all 14 steps are marked passed, at
least the target cycle count is recorded, and the failure count is zero. At that
transition it also requires the same physical device to be online and
synchronized and still report the agent and firmware identities captured when
the run started. The pass then binds the record to the device's final current
configuration version, including configuration changes made by the tested
`SET_MODE` operations. A failed observation, any cycle failure, an unavailable
or unsynchronized device, or an agent/firmware mismatch prevents acceptance.
Abort incomplete runs instead of converting missing evidence into a pass.

A passed record remains historical evidence for that bound state. It is current
for physical automation admission only while the same device still reports the
captured agent and firmware versions and still has the configuration version
bound at pass. A later configuration, agent, or firmware change requires a new
HIL run; the old record is not rewritten or treated as current. Do not recast a
core HIL pass as Batch 8 physical-automation validation.

Do not call the agent a known-good browser-flash package until a physical run
passes and the compiled artifact checksum, board-core version, library versions,
board identity, test date, and operator are retained. Analog calibration, PWM,
and DAC belong to Batch 6 and do not replace or satisfy the Batch 4 digital
acceptance gate.

An older HIL record does not validate new Batch 7 behavior. Supplementary
physical checks remain pending for: no command poll before snapshot
acknowledgment; continued reads and rejected writes under both locks; the
Maintenance-to-Monitor latch and deliberate re-arm; exact per-pin safe-state
acknowledgments including interrupted or partial runs; safe-input boot reporting;
and log/USB-console redaction. Operator-attested interface state is not an
electrical measurement.

Batch 7 does not replace the Batch 4 digital acceptance gate. The
server-commanded safe state provides no autonomous response after link loss, and
the current firmware reports no link-loss timer.

## Batch 8 automation supplementary procedure

The v0.9 server refuses to arm a physical target for automation unless that
device has a current passing core HIL record bound to its configuration, agent,
and firmware versions. A physical threshold source must have the same current
evidence. These software interlocks are necessary but do not prove Batch 8
automation behavior. An older core or Batch 7 record does not validate
thresholds, intervals, schedules, cross-device causation, dry run, cooldowns, or
loop protection.

Keep automation disabled while constructing a fixture. Use a current-limited,
board-supported source for an analog threshold and a logic analyzer or meter on
the output. For cross-device validation, use two separately identified boards
and common fixture ground only where electrically appropriate. Never connect two
outputs together, and do not use a heater, motor, relay controlling hazardous
energy, or other consequential load.

Record server evidence and an independent electrical observation for each check:

1. Create a simulator-only rule and confirm the physical target cannot be used.
2. Confirm a physical-control rule cannot be enabled while the target is
   disarmed, lacks a current matching core HIL record, is offline, is
   unsynchronized, is Monitor Only, or is in Maintenance Mode. Confirm a physical
   threshold source is also rejected when its current matching HIL evidence is
   absent.
3. Run a dry evaluation above the threshold and verify that no GPIO command is
   created and no electrical output changes.
4. Feed fresh samples across the threshold and verify hysteresis, `FOR` duration,
   and exact trigger evidence. Confirm false, stale, missing, disconnected, or
   reconfigured input resets the hold window.
5. Verify one matching source event creates at most one automation execution and
   one output command, even when evaluation is requested concurrently.
6. Verify the output is not reported successful at match, queue, or delivery;
   only the exact matching acknowledgment completes the execution.
7. Disable the rule and disarm the device with queued work present; confirm the
   queue is cancelled. Repeat with a delivered command and document that it
   cannot be recalled.
8. Verify the configured cooldown, rate window, and active-run limit persist
   across browser and server restarts.
9. Construct a harmless feedback pair and verify direct/static cycle rejection,
   causation-depth limits, and repeated-rule suppression stop recursive dispatch.
10. Verify one Coordinated Universal Time (UTC) schedule slot is claimed once,
    delayed activity produces at most one late execution, and missed slots are
    not replayed as a burst.
11. Stop all device and simulator activity and verify an interval or schedule
    does not run. This demonstrates the v0.9 activity-driven timing boundary and
    absence of a durable cron service.
12. Interrupt the source, target, server, and network separately. Verify every
    blocked, timed-out, cancelled, or acknowledged result is preserved with the
    rule revision, source evidence, target action, and command identifier.

Do not mark physical automation accepted from interface state alone. Retain the
rule revision, board identities, wiring/fixture description, provisional and
pass-bound device configuration versions, agent version, firmware version,
server version, trigger samples, command and execution identifiers, independent
electrical observations, interruption timings, failures, test date, and
operator.

The physical firmware remains `0.8.0-device-workbench-candidate`. It starts
managed pins as inputs at boot but has no autonomous link-loss timer. Passing
server automation checks cannot turn remote activity-driven rules into a
firmware-local fail-safe, real-time controller, or safety-rated system.
Even a current core HIL match does not make physical automation a validated
v0.9.0 release capability. The supplementary automation procedure and release
evidence review remain pending.
