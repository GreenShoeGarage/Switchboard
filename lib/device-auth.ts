import type { DatabaseBinding, DatabaseStatement } from "@/db";
import { cancelQueuedAutomationForDevice } from "@/lib/automation-server";
import { listAgentLogs } from "@/lib/agent-server";
import { getBoardProfile } from "@/lib/board-profiles";
import { expireGpioCommands, listGpioCommands } from "@/lib/gpio-server";
import { getDevice, getDevicePins, listConnectionEvents } from "@/lib/registry-server";
import { scaleAnalogRaw, telemetryStatements } from "@/lib/telemetry-server";
import {
  SESSION_TIMEOUT_MS,
  type DeviceCredentialRecord,
  type DeviceSessionRecord,
  type DeviceStateSnapshot,
  type EnrollmentTokenRecord,
} from "@/lib/device-model";

type Row = Record<string, unknown>;
type EnrollmentInput = { boardProfileId: string; deviceName: string; ttlMinutes?: number };
type ExchangeInput = { token: string; hardwareId: string; simulated?: boolean };

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }

function automationCommandLifecycleStatements(db: DatabaseBinding, now: number, timeoutError: string): DatabaseStatement[] {
  return [
    db.prepare(`UPDATE automation_action_runs SET status = 'TIMED_OUT', completed_at = ?, error = ?
      WHERE status IN ('QUEUED', 'DELIVERED') AND gpio_command_id IN (
        SELECT id FROM gpio_commands WHERE status = 'TIMED_OUT' AND completed_at = ? AND error = ?
      )`).bind(now, timeoutError, now, timeoutError),
    db.prepare(`UPDATE automation_action_runs SET status = 'QUEUED', completed_at = NULL, error = ''
      WHERE status = 'DELIVERED' AND gpio_command_id IN (
        SELECT id FROM gpio_commands WHERE status = 'QUEUED' AND delivered_at IS NULL AND session_id IS NULL
      )`),
    db.prepare(`UPDATE automation_executions SET status = 'TIMED_OUT', completed_at = ?, reason = 'One or more automation commands timed out'
      WHERE status IN ('QUEUED', 'RUNNING') AND id IN (
        SELECT execution_id FROM automation_action_runs WHERE status = 'TIMED_OUT' AND completed_at = ? AND error = ?
      )`).bind(now, now, timeoutError),
    db.prepare(`UPDATE automation_executions SET status = 'QUEUED', completed_at = NULL
      WHERE status = 'RUNNING' AND EXISTS (
        SELECT 1 FROM automation_action_runs action JOIN gpio_commands command ON command.id = action.gpio_command_id
        WHERE action.execution_id = automation_executions.id AND action.status = 'QUEUED' AND command.status = 'QUEUED'
      ) AND NOT EXISTS (
        SELECT 1 FROM automation_action_runs action
        WHERE action.execution_id = automation_executions.id AND action.status = 'DELIVERED'
      )`),
  ];
}

function resetThresholdContinuityIfOffline(db: DatabaseBinding, deviceId: string, now: number): DatabaseStatement {
  return db.prepare(`UPDATE automation_triggers SET last_source_event_key = NULL, last_observed_value = NULL,
    condition_since_at = NULL, last_evaluated_at = NULL, updated_at = ?
    WHERE kind = 'THRESHOLD' AND source_device_id = ?
      AND EXISTS (SELECT 1 FROM devices device WHERE device.id = ? AND device.connection_state = 'OFFLINE')
      AND NOT EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.device_id = ? AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
      )`).bind(now, deviceId, deviceId, deviceId);
}

function randomSecret(prefix: string, byteLength = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mapEnrollment(row: Row): EnrollmentTokenRecord {
  return {
    id: text(row.id), tokenPrefix: text(row.token_prefix), boardProfileId: text(row.board_profile_id),
    deviceName: text(row.device_name), expiresAt: Number(row.expires_at), createdAt: Number(row.created_at),
    usedAt: numberOrNull(row.used_at), usedByDeviceId: row.used_by_device_id ? text(row.used_by_device_id) : null,
    revokedAt: numberOrNull(row.revoked_at),
  };
}

function mapCredential(row: Row): DeviceCredentialRecord {
  return {
    id: text(row.id), deviceId: text(row.device_id), secretPrefix: text(row.secret_prefix),
    createdAt: Number(row.created_at), lastUsedAt: numberOrNull(row.last_used_at), revokedAt: numberOrNull(row.revoked_at),
  };
}

function mapSession(row: Row): DeviceSessionRecord {
  return {
    id: text(row.id), deviceId: text(row.device_id), credentialId: text(row.credential_id),
    state: text(row.state) as DeviceSessionRecord["state"], connectedAt: Number(row.connected_at),
    lastHeartbeatAt: Number(row.last_heartbeat_at), disconnectedAt: numberOrNull(row.disconnected_at),
    closeCode: numberOrNull(row.close_code), closeReason: text(row.close_reason),
  };
}

export async function createEnrollmentToken(db: DatabaseBinding, input: EnrollmentInput) {
  const profile = getBoardProfile(input.boardProfileId);
  if (!profile) throw new Error("Unknown board profile");
  const deviceName = input.deviceName.trim().slice(0, 80);
  if (!deviceName) throw new Error("Device name is required");
  const ttlMinutes = Math.max(5, Math.min(60, Math.round(input.ttlMinutes ?? 15)));
  const secret = randomSecret("swenr_");
  const now = Date.now();
  const record: EnrollmentTokenRecord = {
    id: `ENR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    tokenPrefix: `${secret.slice(0, 12)}…`, boardProfileId: profile.id, deviceName,
    expiresAt: now + ttlMinutes * 60_000, createdAt: now, usedAt: null, usedByDeviceId: null, revokedAt: null,
  };
  await db.prepare(`
    INSERT INTO enrollment_tokens (id, token_hash, token_prefix, board_profile_id, device_name, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(record.id, await sha256Hex(secret), record.tokenPrefix, record.boardProfileId, record.deviceName, record.expiresAt, now).run();
  return { record, secret, expiresInMinutes: ttlMinutes };
}

export async function listEnrollmentTokens(db: DatabaseBinding): Promise<EnrollmentTokenRecord[]> {
  const result = await db.prepare(`
    SELECT id, token_prefix, board_profile_id, device_name, expires_at, created_at, used_at, used_by_device_id, revoked_at
    FROM enrollment_tokens ORDER BY created_at DESC LIMIT 40
  `).all<Row>();
  return (result.results ?? []).map(mapEnrollment);
}

export async function revokeEnrollmentToken(db: DatabaseBinding, id: string) {
  await db.prepare("UPDATE enrollment_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(Date.now(), id).run();
  const row = await db.prepare(`
    SELECT id, token_prefix, board_profile_id, device_name, expires_at, created_at, used_at, used_by_device_id, revoked_at
    FROM enrollment_tokens WHERE id = ?
  `).bind(id).first<Row>();
  return row ? mapEnrollment(row) : null;
}

function pinStatements(db: DatabaseBinding, deviceId: string, boardProfileId: string, now: number): DatabaseStatement[] {
  const profile = getBoardProfile(boardProfileId);
  if (!profile) throw new Error("Unknown board profile");
  return profile.pins.map((pin) => db.prepare(`
    INSERT INTO device_pins (device_id, pin_id, label, mode, confirmed_value, updated_at)
    VALUES (?, ?, '', ?, NULL, ?)
  `).bind(deviceId, pin.id, pin.capabilities.includes("analog-input") ? "ANALOG" : "INPUT", now));
}

export async function exchangeEnrollmentToken(db: DatabaseBinding, input: ExchangeInput) {
  const hardwareId = input.hardwareId.trim().slice(0, 128);
  if (hardwareId.length < 4) throw new Error("A stable hardware identifier is required");
  if (!input.token.startsWith("swenr_") || input.token.length < 24) throw new Error("Invalid enrollment token");
  const tokenHash = await sha256Hex(input.token);
  const tokenRow = await db.prepare(`
    SELECT * FROM enrollment_tokens WHERE token_hash = ?
  `).bind(tokenHash).first<Row>();
  if (!tokenRow) throw new Error("Enrollment token was not found");
  const token = mapEnrollment(tokenRow);
  const now = Date.now();
  if (token.revokedAt) throw new Error("Enrollment token was revoked");
  if (token.usedAt) throw new Error("Enrollment token was already used");
  if (token.expiresAt <= now) throw new Error("Enrollment token expired");

  const deviceId = `DEV-${(await sha256Hex(hardwareId)).slice(0, 12).toUpperCase()}`;
  const existing = await getDevice(db, deviceId);
  if (existing && existing.boardProfileId !== token.boardProfileId) throw new Error("Hardware identifier is already registered with another board profile");
  const credential = randomSecret("swdev_", 32);
  const credentialId = `CRED-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const statements: DatabaseStatement[] = [];
  if (!existing) {
    statements.push(db.prepare(`
      INSERT INTO devices (id, name, board_profile_id, kind, connection_state, simulated, maintenance_mode, configuration_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'UNKNOWN', ?, 0, 1, ?, ?)
    `).bind(deviceId, token.deviceName, token.boardProfileId, input.simulated ? "SIMULATED" : "PHYSICAL", input.simulated ? 1 : 0, now, now));
    statements.push(...pinStatements(db, deviceId, token.boardProfileId, now));
  }
  statements.push(
    db.prepare(`UPDATE enrollment_tokens SET used_at = ?, used_by_device_id = ?
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).bind(now, deviceId, token.id, now),
    db.prepare(`
      INSERT INTO device_credentials (id, device_id, enrollment_token_id, secret_hash, secret_prefix, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(credentialId, deviceId, token.id, await sha256Hex(credential), `${credential.slice(0, 12)}…`, now),
    db.prepare("INSERT INTO device_connection_events (device_id, state, reason, occurred_at) VALUES (?, 'UNKNOWN', 'One-time enrollment exchanged; awaiting authenticated socket', ?)").bind(deviceId, now),
  );
  await db.batch(statements);
  return { device: await getDevice(db, deviceId), credential, credentialId, socketPath: "/api/device/socket", protocolVersion: 1 };
}

export async function listCredentials(db: DatabaseBinding, deviceId: string): Promise<DeviceCredentialRecord[]> {
  const result = await db.prepare(`
    SELECT id, device_id, secret_prefix, created_at, last_used_at, revoked_at
    FROM device_credentials WHERE device_id = ? ORDER BY created_at DESC
  `).bind(deviceId).all<Row>();
  return (result.results ?? []).map(mapCredential);
}

export async function authenticateDevice(db: DatabaseBinding, deviceId: string, secret: string) {
  if (!secret.startsWith("swdev_") || secret.length < 32) return null;
  const row = await db.prepare(`
    SELECT id, device_id, secret_prefix, created_at, last_used_at, revoked_at
    FROM device_credentials WHERE device_id = ? AND secret_hash = ? AND revoked_at IS NULL
  `).bind(deviceId, await sha256Hex(secret)).first<Row>();
  if (!row) return null;
  const now = Date.now();
  await db.prepare("UPDATE device_credentials SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, row.id).run();
  return { ...mapCredential(row), lastUsedAt: now };
}

export async function credentialIsActive(db: DatabaseBinding, credentialId: string) {
  return Boolean(await db.prepare("SELECT id FROM device_credentials WHERE id = ? AND revoked_at IS NULL").bind(credentialId).first<Row>());
}

export async function sessionIsConnected(db: DatabaseBinding, sessionId: string, deviceId: string, credentialId: string) {
  return Boolean(await db.prepare(`
    SELECT id FROM device_sessions
    WHERE id = ? AND device_id = ? AND credential_id = ? AND state = 'CONNECTED'
  `).bind(sessionId, deviceId, credentialId).first<Row>());
}

export async function revokeCredential(db: DatabaseBinding, deviceId: string, credentialId: string) {
  const owned = await db.prepare("SELECT id FROM device_credentials WHERE id = ? AND device_id = ?").bind(credentialId, deviceId).first<Row>();
  if (!owned) throw new Error("Device credential not found");
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND device_id = ? AND revoked_at IS NULL").bind(now, credentialId, deviceId),
    db.prepare(`UPDATE gpio_commands SET status = 'TIMED_OUT', completed_at = ?, error = 'Credential revoked during delivery', session_id = NULL
      WHERE status = 'DELIVERED' AND deadline_at <= ? AND session_id IN (SELECT id FROM device_sessions WHERE credential_id = ?)`).bind(now, now, credentialId),
    db.prepare(`UPDATE gpio_commands SET status = 'QUEUED', delivered_at = NULL, session_id = NULL
      WHERE status = 'DELIVERED' AND deadline_at > ? AND session_id IN (SELECT id FROM device_sessions WHERE credential_id = ?)`).bind(now, credentialId),
    ...automationCommandLifecycleStatements(db, now, "Credential revoked during delivery"),
    db.prepare(`UPDATE device_sessions SET state = 'CLOSED', disconnected_at = ?, close_code = 4003, close_reason = 'Credential revoked'
      WHERE credential_id = ? AND state = 'CONNECTED'`).bind(now, credentialId),
    db.prepare(`UPDATE devices SET control_ready = CASE WHEN simulated = 1 OR EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
      ) THEN 1 ELSE 0 END WHERE id = ?`).bind(deviceId),
    db.prepare(`UPDATE devices SET connection_state = 'OFFLINE', control_ready = 0, last_disconnected_at = ?, rssi_dbm = NULL, ip_address = NULL, updated_at = ?
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM device_sessions s JOIN device_credentials c ON c.id = s.credential_id
        WHERE s.device_id = ? AND s.state = 'CONNECTED' AND c.revoked_at IS NULL
      )`).bind(now, now, deviceId, deviceId),
    db.prepare(`INSERT INTO device_connection_events (device_id, state, reason, occurred_at)
      SELECT ?, 'OFFLINE', 'Device credential revoked', ? WHERE NOT EXISTS (
        SELECT 1 FROM device_sessions s JOIN device_credentials c ON c.id = s.credential_id
        WHERE s.device_id = ? AND s.state = 'CONNECTED' AND c.revoked_at IS NULL
      )`).bind(deviceId, now, deviceId),
    resetThresholdContinuityIfOffline(db, deviceId, now),
  ]);
  return listCredentials(db, deviceId);
}

export async function openDeviceSession(db: DatabaseBinding, deviceId: string, credentialId: string) {
  const now = Date.now();
  const id = `SESS-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  await db.batch([
    db.prepare(`INSERT INTO device_sessions (id, device_id, credential_id, state, connected_at, last_heartbeat_at)
      VALUES (?, ?, ?, 'CONNECTED', ?, ?)`).bind(id, deviceId, credentialId, now, now),
    db.prepare(`UPDATE devices SET connection_state = 'ONLINE', control_ready = CASE WHEN simulated = 1 OR EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
      ) THEN 1 ELSE 0 END, last_seen_at = ?, last_connected_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, now, deviceId),
    db.prepare("INSERT INTO device_connection_events (device_id, state, reason, occurred_at) VALUES (?, 'ONLINE', 'Authenticated WebSocket session opened', ?)").bind(deviceId, now),
  ]);
  return { id, connectedAt: now };
}

export async function touchDeviceHeartbeat(db: DatabaseBinding, sessionId: string, deviceId: string, payload: Row = {}) {
  const now = Date.now();
  const rssi = typeof payload.rssiDbm === "number" ? Math.round(payload.rssiDbm) : null;
  const ipAddress = typeof payload.ipAddress === "string" ? payload.ipAddress.slice(0, 64) : null;
  const agent = typeof payload.agentVersion === "string" ? payload.agentVersion.slice(0, 40) : null;
  const firmware = typeof payload.firmwareVersion === "string" ? payload.firmwareVersion.slice(0, 40) : null;
  const currentDevice = await getDevice(db, deviceId);
  const identityChanged = Boolean(currentDevice && (
    (agent !== null && agent !== currentDevice.agentVersion)
    || (firmware !== null && firmware !== currentDevice.firmwareVersion)
  ));
  const automationIdentityChanged = Boolean(currentDevice?.automationArmed && identityChanged);
  const failsafe = payload.localFailsafe && typeof payload.localFailsafe === "object" ? payload.localFailsafe as Row : null;
  const failsafeMode = failsafe && (failsafe.mode === "SAFE_INPUT_BOOT" || failsafe.mode === "LINK_LOSS_SAFE_STATE") ? failsafe.mode : null;
  const failsafeTimeout = failsafeMode === "LINK_LOSS_SAFE_STATE" && typeof failsafe?.timeoutMs === "number" && Number.isSafeInteger(failsafe.timeoutMs) && failsafe.timeoutMs >= 1_000 && failsafe.timeoutMs <= 86_400_000 ? failsafe.timeoutMs : null;
  await db.batch([
    db.prepare(`UPDATE device_sessions SET last_heartbeat_at = ? WHERE id = ? AND device_id = ? AND state = 'CONNECTED'
      AND EXISTS (SELECT 1 FROM device_credentials WHERE id = device_sessions.credential_id AND revoked_at IS NULL)`).bind(now, sessionId, deviceId),
    db.prepare(`UPDATE hardware_test_runs SET status = 'ABORTED', completed_at = ?
      WHERE device_id = ? AND status = 'RUNNING' AND (
        (? IS NOT NULL AND agent_version <> ?)
        OR (? IS NOT NULL AND COALESCE(validated_firmware_version, '') <> ?)
      )`).bind(now, deviceId, agent, agent, firmware, firmware ?? ""),
    db.prepare(`UPDATE devices SET connection_state = 'ONLINE', last_seen_at = ?, rssi_dbm = COALESCE(?, rssi_dbm),
      ip_address = COALESCE(?, ip_address), automation_armed = CASE
        WHEN (? IS NOT NULL AND COALESCE(agent_version, '') <> ?)
          OR (? IS NOT NULL AND COALESCE(firmware_version, '') <> ?) THEN 0 ELSE automation_armed END,
      agent_version = COALESCE(?, agent_version), firmware_version = COALESCE(?, firmware_version),
      firmware_failsafe_mode = COALESCE(?, firmware_failsafe_mode), firmware_failsafe_timeout_ms = CASE WHEN ? IS NULL THEN firmware_failsafe_timeout_ms ELSE ? END,
      firmware_failsafe_reported_at = CASE WHEN ? IS NULL THEN firmware_failsafe_reported_at ELSE ? END, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.id = ? AND session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL)
    `).bind(now, rssi, ipAddress, agent, agent, firmware, firmware, agent, firmware,
      failsafeMode, failsafeMode, failsafeTimeout, failsafeMode, now, now, deviceId, sessionId),
  ]);
  if (automationIdentityChanged) await cancelQueuedAutomationForDevice(db, deviceId, "Agent or firmware identity changed", undefined, now);
  if (!await db.prepare(`SELECT session.id FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
      WHERE session.id = ? AND session.device_id = ? AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL`)
    .bind(sessionId, deviceId).first<Row>()) throw new Error("Heartbeat session is no longer active");
  return now;
}

export async function recordDeviceSnapshot(db: DatabaseBinding, sessionId: string, deviceId: string, sequence: number, payload: Row) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid snapshot sequence");
  const pins = Array.isArray(payload.pins) ? payload.pins.slice(0, 32) as Row[] : [];
  const currentPins = await getDevicePins(db, deviceId);
  const currentByPin = new Map(currentPins.map((pin) => [pin.pinId, pin]));
  const device = await getDevice(db, deviceId);
  const profile = device ? getBoardProfile(device.boardProfileId) : null;
  if (!device || !profile) throw new Error("Device profile is unavailable");
  const snapshotPinIds = pins.map((pin) => text(pin.pinId));
  const expectedPinIds = new Set(profile.pins.map((pin) => pin.id));
  if (pins.length !== profile.pins.length || new Set(snapshotPinIds).size !== pins.length || snapshotPinIds.some((pinId) => !expectedPinIds.has(pinId))) {
    throw new Error("A complete, unique board-profile snapshot is required before control can be enabled");
  }
  const profileByPin = new Map(profile?.pins.map((pin) => [pin.id, pin]) ?? []);
  const now = Date.now();
  const stateStatements: DatabaseStatement[] = [];
  const sampleStatements: DatabaseStatement[] = [];
  const normalizedPins: Array<{ pinId: string; value: number; rawValue?: number; mode: string }> = [];
  for (const pin of pins) {
    const pinId = text(pin.pinId).slice(0, 8);
    const value = pin.value;
    const current = currentByPin.get(pinId);
    const profilePin = profileByPin.get(pinId);
    if (!current || !profilePin || typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid snapshot pin: ${pinId || "missing"}`);
    const mode = typeof pin.mode === "string" ? pin.mode : current.mode;
    const modeAllowed = (mode === "INPUT" || mode === "INPUT_PULLUP") ? profilePin.capabilities.includes("digital-input")
      : mode === "OUTPUT" ? profilePin.capabilities.includes("digital-output")
      : mode === "ANALOG" ? profilePin.capabilities.includes("analog-input")
      : mode === "PWM" ? profilePin.capabilities.includes("pwm")
      : mode === "DAC" ? profilePin.capabilities.includes("dac-output") : false;
    if (!modeAllowed) throw new Error(`Invalid snapshot mode for ${pinId}`);
    let confirmedValue = value;
    let rawValue: number | null = null;
    if (mode === "ANALOG") {
      const scaled = scaleAnalogRaw(device!.boardProfileId, current, value);
      confirmedValue = scaled.engineeringValue;
      rawValue = scaled.rawValue;
      normalizedPins.push({ pinId, value: confirmedValue, rawValue, mode });
      sampleStatements.push(...telemetryStatements(db, {
        deviceId, pinId, sequence, rawValue, voltageValue: scaled.voltageValue,
        engineeringValue: confirmedValue, engineeringUnit: scaled.engineeringUnit, recordedAt: now,
        acceptedSnapshot: { sessionId, sequence },
      }));
    } else {
      if ((mode === "PWM" || mode === "DAC") && (!Number.isInteger(value) || value < 0 || value > 4095)) throw new Error(`Invalid 12-bit output value for ${pinId}`);
      if ((mode === "INPUT" || mode === "INPUT_PULLUP" || mode === "OUTPUT") && value !== 0 && value !== 1) throw new Error(`Invalid digital value for ${pinId}`);
      normalizedPins.push({ pinId, value, mode });
    }
    stateStatements.push(db.prepare(`UPDATE device_pins SET mode = ?, confirmed_value = ?, confirmed_raw_value = ?, sampled_at = ?, updated_at = ?
      WHERE device_id = ? AND pin_id = ? AND NOT EXISTS (
        SELECT 1 FROM gpio_commands WHERE device_id = ? AND pin_id = ?
          AND status IN ('QUEUED', 'DELIVERED') AND deadline_at > ?
      ) AND EXISTS (SELECT 1 FROM device_state_snapshots WHERE device_id = ? AND session_id = ? AND sequence = ?)
    `).bind(mode, confirmedValue, rawValue, mode === "ANALOG" ? now : null, now, deviceId, pinId, deviceId, pinId, now, deviceId, sessionId, sequence));
  }
  const safePayload = JSON.stringify({ pins: normalizedPins });
  if (safePayload.length > 16_384) throw new Error("Snapshot exceeds the 16 KiB limit");
  const statements: DatabaseStatement[] = [
    db.prepare(`INSERT INTO device_state_snapshots (device_id, session_id, sequence, payload_json, recorded_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.id = ? AND session.device_id = ? AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
      )`).bind(deviceId, sessionId, sequence, safePayload, now, sessionId, deviceId),
    ...stateStatements,
    ...sampleStatements,
    db.prepare(`UPDATE device_sessions SET last_heartbeat_at = ? WHERE id = ? AND device_id = ? AND state = 'CONNECTED'
      AND EXISTS (SELECT 1 FROM device_state_snapshots WHERE device_id = ? AND session_id = ? AND sequence = ?)
    `).bind(now, sessionId, deviceId, deviceId, sessionId, sequence),
    db.prepare(`UPDATE devices SET connection_state = 'ONLINE', control_ready = CASE WHEN simulated = 1 OR EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
      ) THEN 1 ELSE 0 END, last_seen_at = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM device_state_snapshots WHERE device_id = ? AND session_id = ? AND sequence = ?)
    `).bind(now, now, deviceId, deviceId, sessionId, sequence),
  ];
  await db.batch(statements);
  if (!await db.prepare("SELECT id FROM device_state_snapshots WHERE device_id = ? AND session_id = ? AND sequence = ?")
    .bind(deviceId, sessionId, sequence).first<Row>()) throw new Error("Snapshot session is no longer active");
  return { recordedAt: now, pins: await getDevicePins(db, deviceId) };
}

export async function closeDeviceSession(db: DatabaseBinding, sessionId: string, deviceId: string, code: number, reason: string) {
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE gpio_commands SET status = 'TIMED_OUT', completed_at = ?, error = 'Session closed after command deadline', session_id = NULL
      WHERE session_id = ? AND status = 'DELIVERED' AND deadline_at <= ?`).bind(now, sessionId, now),
    db.prepare(`UPDATE gpio_commands SET status = 'QUEUED', delivered_at = NULL, session_id = NULL
      WHERE session_id = ? AND status = 'DELIVERED' AND deadline_at > ?`).bind(sessionId, now),
    ...automationCommandLifecycleStatements(db, now, "Session closed after command deadline"),
    db.prepare("UPDATE device_sessions SET state = 'CLOSED', disconnected_at = ?, close_code = ?, close_reason = ? WHERE id = ? AND state = 'CONNECTED'").bind(now, code, reason.slice(0, 120), sessionId),
    db.prepare(`UPDATE devices SET control_ready = CASE WHEN simulated = 1 OR EXISTS (
        SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
        WHERE session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
      ) THEN 1 ELSE 0 END WHERE id = ?`).bind(deviceId),
    db.prepare(`UPDATE devices SET connection_state = 'OFFLINE', control_ready = 0, last_disconnected_at = ?, rssi_dbm = NULL, ip_address = NULL, updated_at = ?
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM device_sessions WHERE device_id = ? AND state = 'CONNECTED' AND id <> ?)
    `).bind(now, now, deviceId, deviceId, sessionId),
    db.prepare(`INSERT INTO device_connection_events (device_id, state, reason, occurred_at)
      SELECT ?, 'OFFLINE', ?, ? WHERE NOT EXISTS (SELECT 1 FROM device_sessions WHERE device_id = ? AND state = 'CONNECTED' AND id <> ?)
    `).bind(deviceId, `WebSocket closed: ${reason || code}`.slice(0, 160), now, deviceId, sessionId),
    resetThresholdContinuityIfOffline(db, deviceId, now),
  ]);
}

export async function reapStaleSessions(db: DatabaseBinding, deviceId?: string) {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  const query = deviceId
    ? "SELECT id, device_id FROM device_sessions WHERE state = 'CONNECTED' AND last_heartbeat_at < ? AND device_id = ?"
    : "SELECT id, device_id FROM device_sessions WHERE state = 'CONNECTED' AND last_heartbeat_at < ?";
  const statement = db.prepare(query).bind(...(deviceId ? [cutoff, deviceId] : [cutoff]));
  const stale = (await statement.all<Row>()).results ?? [];
  for (const row of stale) {
    const now = Date.now();
    const staleDeviceId = text(row.device_id);
    await db.batch([
      db.prepare("UPDATE device_sessions SET state = 'TIMED_OUT', disconnected_at = ?, close_code = 4000, close_reason = 'Heartbeat timeout' WHERE id = ? AND state = 'CONNECTED'").bind(now, row.id),
      db.prepare(`UPDATE devices SET control_ready = CASE WHEN simulated = 1 OR EXISTS (
          SELECT 1 FROM device_sessions session JOIN device_credentials credential ON credential.id = session.credential_id
          WHERE session.device_id = devices.id AND session.state = 'CONNECTED' AND credential.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
        ) THEN 1 ELSE 0 END WHERE id = ?`).bind(staleDeviceId),
      db.prepare(`UPDATE devices SET connection_state = 'OFFLINE', control_ready = 0, last_disconnected_at = ?, rssi_dbm = NULL, ip_address = NULL, updated_at = ?
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM device_sessions WHERE device_id = ? AND state = 'CONNECTED' AND id <> ?)
      `).bind(now, now, staleDeviceId, staleDeviceId, row.id),
      db.prepare(`INSERT INTO device_connection_events (device_id, state, reason, occurred_at)
        SELECT ?, 'OFFLINE', 'Heartbeat timeout', ? WHERE NOT EXISTS (SELECT 1 FROM device_sessions WHERE device_id = ? AND state = 'CONNECTED' AND id <> ?)
      `).bind(staleDeviceId, now, staleDeviceId, row.id),
      resetThresholdContinuityIfOffline(db, staleDeviceId, now),
    ]);
  }
  return stale.length;
}

export async function listSessions(db: DatabaseBinding, deviceId: string): Promise<DeviceSessionRecord[]> {
  await reapStaleSessions(db, deviceId);
  const result = await db.prepare(`SELECT id, device_id, credential_id, state, connected_at, last_heartbeat_at, disconnected_at, close_code, close_reason
    FROM device_sessions WHERE device_id = ? ORDER BY connected_at DESC LIMIT 30`).bind(deviceId).all<Row>();
  return (result.results ?? []).map(mapSession);
}

export async function listSnapshots(db: DatabaseBinding, deviceId: string): Promise<DeviceStateSnapshot[]> {
  const result = await db.prepare(`SELECT id, device_id, session_id, sequence, payload_json, recorded_at
    FROM device_state_snapshots WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 10`).bind(deviceId).all<Row>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id), deviceId: text(row.device_id), sessionId: row.session_id ? text(row.session_id) : null,
    sequence: Number(row.sequence), payload: JSON.parse(text(row.payload_json)) as Record<string, unknown>, recordedAt: Number(row.recorded_at),
  }));
}

export async function getTransportBundle(db: DatabaseBinding, deviceId: string) {
  await reapStaleSessions(db, deviceId);
  await expireGpioCommands(db, deviceId);
  const device = await getDevice(db, deviceId);
  if (!device) return null;
  const [pins, events, credentials, sessions, snapshots, commands, logs] = await Promise.all([
    getDevicePins(db, deviceId), listConnectionEvents(db, deviceId), listCredentials(db, deviceId), listSessions(db, deviceId), listSnapshots(db, deviceId), listGpioCommands(db, deviceId), listAgentLogs(db, deviceId),
  ]);
  return { device, pins, events, credentials, sessions, snapshots, commands, logs };
}
