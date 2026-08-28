# Changelog

All notable changes to SWITCHBOARD are documented here. The project uses
[Semantic Versioning](https://semver.org/).

## [0.10.0] - 2026-08-28

### Added

- Independent self-hosted Node.js runtime with native WebSocket upgrades
- SQLite adapter with WAL mode, foreign keys, ordered automatic migrations, and
  persistent installation state
- One-time bootstrap owner, scrypt password hashing, hashed opaque sessions,
  strict cookies, setup/login rate limits, and sign-out
- Docker Compose deployment with a private app service, Caddy automatic HTTPS,
  persistent data volumes, and liveness/readiness checks
- Community installation, backup, security, and contribution documentation

### Changed

- Application version advances to 0.10.0 and database schema version to 9
- Operator identity is created only by the community server after local session
  authentication; hosted-platform identity headers and allowlists are removed
- The Device Protocol remains version 1 and the UNO R4 WiFi candidate remains
  compatible without a hosting-specific firmware fork
- Production startup uses a bundled plain Node.js server instead of a runtime
  TypeScript loader

### Security

- The server strips inbound trusted identity/address headers, gates all operator
  pages and APIs, and leaves only exact enrollment and device-socket paths public
- Setup becomes unavailable after the singleton installation transaction succeeds
- The supplied Compose topology does not publish the application port directly

## [0.9.0] - 2026-08-28

### Added

- Structured, persisted automation rules with `DISABLED`, `DRY_RUN`, and `LIVE`
  modes and optimistic rule revisions
- Threshold triggers over confirmed pin state with six comparators, hysteresis,
  fresh-sample `FOR` duration, maximum sample age, and source configuration/unit
  fencing
- Best-effort interval and day/time schedule triggers using Coordinated Universal
  Time (UTC)
- Exactly one bounded absolute digital, Pulse Width Modulation (PWM), or
  Digital-to-Analog Converter (DAC) action per Batch 8 rule, including
  cross-device targets
- Explicit target-device automation permission and simulator-only or
  physical-control rule scope
- Persistent execution and action-run evidence with rule revision, source event,
  trigger value/time, actor, causation lineage, command identifier, and outcome
- Dedicated Automation workbench with structured WHEN → FOR → THEN editing,
  dry-run evidence, policy readiness, and execution history

### Changed

- Application version advances to 0.9.0 and database schema version to 8
- General-Purpose Input/Output (GPIO) command provenance now distinguishes
  `OPERATOR`, `SERVER_SAFE_STATE`, and
  `AUTOMATION` and links automation commands to the exact rule revision,
  execution, and action
- Device records now include a persistent automation-armed policy, false by default
- Every rule definition update, mode transition, automatic fallback transition,
  and archive operation advances the optimistic revision
- HIL runs now capture reported agent and firmware identity plus a provisional
  configuration version at start, then bind a successful pass to the device's
  final current configuration version
- The physical firmware remains `0.8.0-device-workbench-candidate`; Batch 8 is a
  server/workbench feature and does not manufacture a new firmware validation claim

### Security and safety

- Rule input is strict structured data; unknown or executable fields, unsupported
  actions, invalid values, direct self-loops, incompatible pin modes, and stale
  revisions are rejected
- New and edited rules are disabled, live revisions require explicit approval,
  and live execution requires at least a five-second cooldown
- Cooldowns, bounded execution-rate windows, one active run per rule, static
  dependency-cycle rejection, causation-depth limits, and source-event
  idempotency suppress duplicate or recursive dispatch
- Online state, accepted current-session snapshots, device permission,
  Maintenance Mode, Monitor Only, configuration revision, output mode/value, and
  pending-pin state are rechecked through the normal GPIO issue and claim path
- Disabling a rule, disarming a device, or enabling a device lock cancels queued
  automation commands; already delivered hardware commands cannot be recalled
- Dry run stores evidence and intended actions without creating a GPIO command
- Physical targets require explicit physical-control scope, device arming, and a
  current passing Hardware-in-the-Loop (HIL) record; physical threshold sources
  require the same current evidence
- A HIL pass is current for automation only while its pass-bound device
  configuration version and start-captured agent and firmware versions match the
  device. Physical automation nevertheless remains unvalidated in this release
- Execution pruning preserves the newest 500 records plus active work, commands
  awaiting completion, and recent live executions still needed for cooldown and
  rate admission; 500 is not a hard database-row cap

### Timing boundary

- Threshold evaluation is driven by newly accepted device state. Interval and UTC
  schedule due checks run during device heartbeat, command-poll, or simulator
  activity
- The deployed Worker has no durable scheduled/cron handler. Timed rules can be
  delayed until activity occurs, missed occurrences are not replayed, and no
  real-time or unattended scheduler guarantee is claimed

### Validation status

- Migration, validation, threshold, dry-run, simulator dispatch, UTC-slot,
  permission, provenance, and interface contracts are covered by the test suite
- Physical automation HIL, a durable platform scheduler, Arduino compilation,
  verified binary publication, browser erase/write, and an external device
  endpoint remain pending

## [0.8.0] - 2026-08-28

### Added

- Unified Device Workbench with Board, Details, Universal Serial Bus (USB)
  Console, Agent Logs, and Safety tabs
- Profile-ordered interactive board, pin inspector, requested/confirmed state,
  and configured-safe-target visualization
- Persistent Monitor Only policy and Maintenance Mode latch
- Physical-session control-ready gate after an exact complete snapshot
- Per-output server safe-state values, aggregate run state, actor, command origin,
  and shared run provenance
- Authenticated firmware-local fail-safe report kept distinct from server behavior
- Searchable and level-filtered server-redacted logs with bounded CSV export
- Browser-local 115200-baud console restricted to `status` and `identify`

### Changed

- Application version is 0.8.0 and database schema version is 7
- Configuration export advances to `switchboard.config.v4`; v2 and v3 imports
  remain accepted
- Physical Agent source advances to `0.8.0-device-workbench-candidate`
- The candidate agent waits for `device.snapshot.ack` before command polling

### Security

- Command issue and atomic claim recheck online, control-ready, Maintenance, and
  Monitor Only state; claiming also requires the polling session's accepted snapshot
- Enabling a lock fails queued commands and is refused while a delivered command
  remains in flight; Maintenance implies a latched Monitor Only state
- CSV formula-leading cells are neutralized, and the USB console blocks secrets,
  provisioning, and configuration erase commands
- The server-commanded safe-state profile is not represented as autonomous
  link-loss protection or as an atomic physical transition

### Validation status

- Application, server, simulator, migration, interface, protocol, and source
  contracts are complete
- Arduino compilation, physical Hardware-in-the-Loop (HIL), verified binary
  publication, browser erase/write, and an external device endpoint remain pending

## [0.7.0] - 2026-08-28

### Added

- Validated 14-bit analog snapshots stored as raw counts, voltage, and calibrated
  engineering values
- Two-point per-pin analog calibration with a live persisted-history monitor
- Bounded telemetry storage: at most one sample per second and 720 samples per pin
- Comma-Separated Values (CSV) telemetry export with sequence and recorded time
- Acknowledged 12-bit Pulse Width Modulation (PWM) and Digital-to-Analog
  Converter (DAC) output commands
- Agent source support for analog input, PWM, and DAC modes and values
- Batch 6 migration, scaling, retention, command, and physical-snapshot contracts

### Changed

- Application version is 0.7.0 and database schema version is 6
- Configuration export advances to `switchboard.config.v3`; v2 imports remain accepted
- Physical Agent source advances to `0.7.0-analog-pwm-candidate`

### Security

- All mode changes and analog-output values remain requested until the exact
  device acknowledgment arrives
- Analog input, calibration, PWM, and DAC values are bounded at the server boundary
- The owner-only hosted Site remains private; physical hardware still requires a
  separate device-accessible endpoint

### Validation status

- Server, simulator, interface, migration, protocol, and source contracts are complete
- Physical HIL, Arduino compilation, and browser erase/write remain pending;
  v0.7.0 is not a known-good flash package

## [0.6.0] - 2026-08-28

### Added

- Arduino-filtered Web Serial selection with runtime and bootloader VID/PID identity
- Candidate release manifest with board, core, protocol, Bossac/SAM-BA upload,
  maximum-size, source SHA-256, binary, and HIL evidence fields
- Browser verification of the published source bytes against the manifest
- Direct 115200-baud agent identity, status, provisioning, and configuration-clear flow
- 1200-bps bootloader handoff, changed-port reselection guidance, and double-reset recovery
- Firmware serial acknowledgments for identify, provision, and clear operations
- Batch 5 manifest, identity, source-publication, and erase/write-interlock tests

### Changed

- Application version is 0.6.0; database schema remains version 5
- Physical Agent becomes the guided Browser Provisioning workbench
- Browser simulator messages now report agent v0.6.0

### Security

- Wi-Fi credentials travel from the operator's browser directly to the selected
  serial port and are cleared from the form after a board acknowledgment
- USB selection is filtered to the documented UNO R4 WiFi application identifiers
- Browser erase/write fails closed while no compiled binary or physical HIL evidence exists
- ESP32-S3 bridge firmware remains explicitly outside the RA4M1 application workflow

### Validation status

- Browser plumbing, manifest/source integrity, and contract tests are complete
- Physical HIL, Arduino compilation, and a browser Bossac erase/write engine remain
  pending; v0.6.0 is not a known-good flash package

## [0.5.0] - 2026-08-28

### Added

- Arduino UNO R4 WiFi agent candidate aligned with Device Protocol 1 enrollment,
  authentication, heartbeat, state snapshots, command polling, and GPIO acknowledgments
- Manual flash package, pinned Arduino toolchain, and local serial provisioner
- Safe-input boot for all managed pins, bounded Wi-Fi/socket retry, and complete
  digital/analog pin snapshots with reported modes
- Bounded, server-redacted physical-agent logs retained per device
- Persistent operator-attested Hardware-in-the-Loop runs with 14 evidence steps,
  a minimum 1,000-cycle target, and zero-failure pass gate
- Physical Agent workbench for download, provisioning, status, logs, and HIL evidence
- Batch 4 migration and agent/HIL contract tests

### Changed

- Application version is 0.5.0 and database schema version is 5
- Browser simulator messages now report agent v0.5.0 and pin modes
- The UNO R4 WiFi profile is marked as a hardware-validation candidate

### Security

- One-time enrollment tokens are erased from the device configuration after exchange
- Firmware logs never intentionally contain Wi-Fi passwords or device credentials;
  server storage applies a second redaction boundary
- The owner-only hosted Site remains private and is explicitly not represented as a
  device-accessible endpoint

### Validation status

- Source, server contracts, migration, and automated tests are complete
- Arduino compilation and the physical-board HIL pass remain pending; v0.5.0 is not
  a known-good browser-flash package

## [0.4.0] - 2026-08-28

### Added

- Persistent digital GPIO command ledger with requested, delivered,
  acknowledged, failed, and timed-out states
- Acknowledged digital output writes and digital mode changes over the
  authenticated device WebSocket
- Requested-versus-confirmed pin state, five-second deadlines, and one active
  command per pin
- Persistent command actor, timing, latency, device timestamp, error, and
  confirmation audit data
- Editable pin labels and logical low/high state names
- Browser transport simulator support for authenticated command polling and
  acknowledgments
- Batch 3 schema and GPIO contract tests

### Changed

- Application version is 0.4.0 and database schema version is 4
- Simulator commands now use the same persistent command ledger as socket devices
- Digital pin modes can no longer be changed through an unacknowledged metadata
  update or configuration import
- The active release milestone advances from transport to the UNO R4 WiFi agent

### Security

- Confirmed pin state changes only after an acknowledgment matches the exact
  command ID, pin, mode, and value before its deadline
- Rejected, mismatched, late, and unacknowledged commands fail closed without
  overwriting the last confirmed state
- The private deployment boundary remains unchanged; physical hardware access
  still requires a deliberately configured device endpoint

## [0.3.0] - 2026-08-27

### Added

- Short-lived, one-time enrollment-token issuance and exchange
- Individually revocable device credentials stored only as SHA-256 digests
- Auth-first device WebSocket endpoint with a five-second authentication window
- Persistent device sessions, heartbeats, and validated state snapshots
- Browser live updates and a bounded 1, 2, 4, 8, 8 second reconnect schedule
- Authenticated in-browser transport self-test and credential/session workbench
- Batch 2 schema, enrollment, revocation, and transport contract tests

### Changed

- Application version is 0.3.0 and database schema version is 3
- The active release milestone advances from device model to transport

### Security

- Enrollment and device secrets are shown only at issuance and never stored raw
- Credential validity is rechecked for every authenticated socket message
- Socket authentication, message size, snapshot pin, and snapshot payload bounds
  are enforced server-side
- The private hosted boundary is disclosed: external hardware access requires a
  separately configured device-accessible deployment boundary

## [0.2.0] - 2026-08-27

### Added

- Persistent D1 device registry, groups, pin configuration, and connection events
- Generated database schema migration and deployment binding
- Validated read-only board-profile loader with a complete UNO R4 WiFi pin map
- Server-managed simulator creation, deletion, signal ticks, and acknowledgments
- Persistent online, offline, reconnecting, and unknown connection states
- Device registry search, filtering, sorting, grouping, and configuration tools
- Non-secret `switchboard.config.v2` import and export
- Batch 1 migration, profile, API contract, and release tests

### Changed

- Empty first-run state now asks the operator to explicitly create a simulator
- Simulator settings and state now survive browser and server restarts
- Application version is 0.2.0 and database schema version is 2

### Security

- Built-in profiles are exposed read-only
- Only simulated devices may be deleted through the sample-data action
- Offline and Maintenance Mode checks are enforced by the server command route
- Configuration exports explicitly exclude secrets

## [0.1.0] - 2026-08-27

### Added

- Field Instrument user interface with Easy and Advanced modes
- Clearly labeled Arduino UNO R4 WiFi device simulator
- Requested-versus-confirmed digital output state
- Simulator latency, heartbeat, offline behavior, and analog signals
- Pin workbench, analog monitor, maintenance lock, and audit trail
- Browser Web Serial device-selection workflow
- Honest firmware flashing gate with actionable compatibility feedback
- Non-secret configuration import and export
- UNO R4 WiFi board profile and agent source
- Flasher and device-protocol abstractions
- Deployment, testing, security, and roadmap documentation

### Security

- No credentials are collected by the v0.1.0 workbench
- Hardware-changing commands are disabled while offline or in maintenance mode
- Simulated data is explicitly labeled throughout the interface
