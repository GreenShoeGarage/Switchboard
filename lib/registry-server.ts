import { getBoardProfile } from "@/lib/board-profiles";
import type { DatabaseBinding } from "@/db";
import { APP_VERSION, type ConnectionEvent, type DeviceGroup, type DevicePin, type DeviceRecord, type DeviceState, type FirmwareFailsafeMode, type PinMode } from "@/lib/device-model";

type DeviceRow = Record<string, unknown>;

function booleanValue(value: unknown) { return value === true || value === 1; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }
function stringOrNull(value: unknown) { return typeof value === "string" ? value : null; }

export function mapDevice(row: DeviceRow): DeviceRecord {
  const boardProfileId = String(row.board_profile_id);
  return {
    id: String(row.id), name: String(row.name), boardProfileId,
    boardName: getBoardProfile(boardProfileId)?.name ?? boardProfileId,
    kind: String(row.kind) as DeviceRecord["kind"],
    connectionState: String(row.connection_state) as DeviceState,
    groupId: stringOrNull(row.group_id), groupName: stringOrNull(row.group_name),
    agentVersion: stringOrNull(row.agent_version), firmwareVersion: stringOrNull(row.firmware_version),
    rssiDbm: numberOrNull(row.rssi_dbm), ipAddress: stringOrNull(row.ip_address),
    lastSeenAt: numberOrNull(row.last_seen_at), lastConnectedAt: numberOrNull(row.last_connected_at),
    lastDisconnectedAt: numberOrNull(row.last_disconnected_at), simulated: booleanValue(row.simulated),
    maintenanceMode: booleanValue(row.maintenance_mode), monitorOnly: booleanValue(row.monitor_only), automationArmed: booleanValue(row.automation_armed), controlReady: booleanValue(row.control_ready),
    firmwareFailsafeMode: String(row.firmware_failsafe_mode ?? "NOT_REPORTED") as FirmwareFailsafeMode,
    firmwareFailsafeTimeoutMs: numberOrNull(row.firmware_failsafe_timeout_ms),
    firmwareFailsafeReportedAt: numberOrNull(row.firmware_failsafe_reported_at),
    configurationVersion: Number(row.configuration_version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export async function listDevices(db: DatabaseBinding) {
  const result = await db.prepare(`
    SELECT d.*, g.name AS group_name
    FROM devices d
    LEFT JOIN device_groups g ON g.id = d.group_id
    ORDER BY CASE d.connection_state WHEN 'ONLINE' THEN 0 WHEN 'RECONNECTING' THEN 1 WHEN 'OFFLINE' THEN 2 ELSE 3 END, lower(d.name)
  `).all<DeviceRow>();
  return (result.results ?? []).map(mapDevice);
}

export async function getDevice(db: DatabaseBinding, id: string) {
  const row = await db.prepare(`
    SELECT d.*, g.name AS group_name
    FROM devices d
    LEFT JOIN device_groups g ON g.id = d.group_id
    WHERE d.id = ?
  `).bind(id).first<DeviceRow>();
  return row ? mapDevice(row) : null;
}

export async function getDevicePins(db: DatabaseBinding, deviceId: string): Promise<DevicePin[]> {
  const device = await getDevice(db, deviceId);
  if (!device) return [];
  const profile = getBoardProfile(device.boardProfileId);
  const capabilityByPin = new Map(profile?.pins.map((pin) => [pin.id, pin.capabilities.join(" · ").toUpperCase()]) ?? []);
  const result = await db.prepare(`
    SELECT p.device_id, p.pin_id, p.label, p.mode, p.confirmed_value, p.confirmed_raw_value, p.sampled_at, p.logical_low_label, p.logical_high_label,
      p.engineering_unit, p.scale_input_low, p.scale_output_low, p.scale_input_high, p.scale_output_high, p.server_safe_value,
      c.id AS pending_command_id, c.kind AS pending_command_kind, c.requested_mode, c.requested_value,
      c.status AS pending_command_status, c.requested_at, c.deadline_at
    FROM device_pins p
    LEFT JOIN gpio_commands c ON c.id = (
      SELECT command.id FROM gpio_commands command
      WHERE command.device_id = p.device_id AND command.pin_id = p.pin_id
        AND command.status IN ('QUEUED', 'DELIVERED') AND command.deadline_at > ?
      ORDER BY command.requested_at DESC LIMIT 1
    )
    WHERE p.device_id = ?
    ORDER BY CASE substr(p.pin_id, 1, 1) WHEN 'D' THEN 0 WHEN 'A' THEN 1 ELSE 2 END,
      CAST(substr(p.pin_id, 2) AS INTEGER), p.pin_id
  `).bind(Date.now(), deviceId).all<DeviceRow>();
  return (result.results ?? []).map((row) => ({
    deviceId: String(row.device_id), pinId: String(row.pin_id), label: String(row.label),
    mode: String(row.mode) as PinMode, confirmedValue: numberOrNull(row.confirmed_value),
    confirmedRawValue: numberOrNull(row.confirmed_raw_value), sampledAt: numberOrNull(row.sampled_at),
    logicalLowLabel: stringOrNull(row.logical_low_label), logicalHighLabel: stringOrNull(row.logical_high_label),
    engineeringUnit: stringOrNull(row.engineering_unit), scaleInputLow: numberOrNull(row.scale_input_low),
    scaleOutputLow: numberOrNull(row.scale_output_low), scaleInputHigh: numberOrNull(row.scale_input_high),
    scaleOutputHigh: numberOrNull(row.scale_output_high), serverSafeValue: numberOrNull(row.server_safe_value),
    capability: capabilityByPin.get(String(row.pin_id)) ?? "UNKNOWN",
    pendingCommandId: stringOrNull(row.pending_command_id),
    pendingCommandKind: stringOrNull(row.pending_command_kind) as DevicePin["pendingCommandKind"],
    requestedMode: stringOrNull(row.requested_mode) as DevicePin["requestedMode"],
    requestedValue: numberOrNull(row.requested_value),
    pendingCommandStatus: stringOrNull(row.pending_command_status) as DevicePin["pendingCommandStatus"],
    requestedAt: numberOrNull(row.requested_at), commandDeadlineAt: numberOrNull(row.deadline_at),
  }));
}

export async function listGroups(db: DatabaseBinding): Promise<DeviceGroup[]> {
  const result = await db.prepare(`
    SELECT g.id, g.name, g.description, count(d.id) AS device_count
    FROM device_groups g LEFT JOIN devices d ON d.group_id = g.id
    GROUP BY g.id, g.name, g.description ORDER BY lower(g.name)
  `).all<DeviceRow>();
  return (result.results ?? []).map((row) => ({ id: String(row.id), name: String(row.name), description: String(row.description), deviceCount: Number(row.device_count) }));
}

export async function listConnectionEvents(db: DatabaseBinding, deviceId: string): Promise<ConnectionEvent[]> {
  const result = await db.prepare(`
    SELECT id, state, reason, occurred_at FROM device_connection_events
    WHERE device_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 20
  `).bind(deviceId).all<DeviceRow>();
  return (result.results ?? []).map((row) => ({ id: Number(row.id), state: String(row.state) as DeviceState, reason: String(row.reason), occurredAt: Number(row.occurred_at) }));
}

const defaultPinSettings: Record<string, Partial<{ label: string; mode: PinMode; value: number; safe: number; unit: string; lowIn: number; lowOut: number; highIn: number; highOut: number; lowLabel: string; highLabel: string }>> = {
  D2: { label: "Door Switch", mode: "INPUT_PULLUP", value: 1, lowLabel: "OPEN", highLabel: "CLOSED" },
  D3: { label: "Emergency Stop", mode: "INPUT", value: 0, lowLabel: "SAFE", highLabel: "TRIPPED" },
  D5: { label: "Fan PWM", mode: "PWM", value: 42, safe: 0, unit: "%" },
  D7: { label: "Pump Relay", mode: "OUTPUT", value: 0, safe: 0, lowLabel: "STOPPED", highLabel: "RUNNING" },
  D8: { label: "Heater Enable", mode: "OUTPUT", value: 0, safe: 0, lowLabel: "DISABLED", highLabel: "ENABLED" },
  A0: { label: "Pressure", mode: "ANALOG", value: 41.5, unit: "PSI", lowIn: 0.5, lowOut: 0, highIn: 4.5, highOut: 100 },
  A1: { label: "Temperature", mode: "ANALOG", value: 24.3, unit: "°C", lowIn: 0, lowOut: 0, highIn: 5, highOut: 50 },
};

export async function createSimulator(db: DatabaseBinding, input: { id?: string; name?: string; ensure?: boolean } = {}) {
  const id = input.id ?? (input.ensure ? "SIM-UNO-R4-01" : `SIM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const existing = await getDevice(db, id);
  if (existing) return existing;
  const now = Date.now();
  const profile = getBoardProfile("arduino-uno-r4-wifi");
  if (!profile) throw new Error("UNO R4 WiFi board profile is unavailable");
  const statements = [
    db.prepare("INSERT OR IGNORE INTO device_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind("GROUP-WORKSHOP", "Workshop", "Bench and development devices", now, now),
    db.prepare(`
      INSERT INTO devices (id, name, board_profile_id, kind, connection_state, group_id, agent_version,
        firmware_version, rssi_dbm, ip_address, last_seen_at, last_connected_at, simulated,
        maintenance_mode, monitor_only, automation_armed, control_ready, firmware_failsafe_mode, firmware_failsafe_reported_at,
        configuration_version, created_at, updated_at)
      VALUES (?, ?, ?, 'SIMULATED', 'ONLINE', ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 1, 'SAFE_INPUT_BOOT', ?, 1, ?, ?)
    `).bind(id, input.name?.trim().slice(0, 80) || (input.ensure ? "Workshop Bench" : "New Simulator"), profile.id, "GROUP-WORKSHOP", `${APP_VERSION}-sim`, `${APP_VERSION}-sim`, -54, "192.168.1.81", now, now, now, now, now),
    db.prepare("INSERT INTO device_connection_events (device_id, state, reason, occurred_at) VALUES (?, 'ONLINE', 'Simulator created', ?)").bind(id, now),
  ];
  for (const pin of profile.pins) {
    const defaults = defaultPinSettings[pin.id] ?? {};
    statements.push(db.prepare(`
      INSERT INTO device_pins (device_id, pin_id, label, mode, confirmed_value, logical_low_label, logical_high_label, engineering_unit,
        scale_input_low, scale_output_low, scale_input_high, scale_output_high, server_safe_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, pin.id, defaults.label ?? "", defaults.mode ?? (pin.capabilities.includes("analog-input") ? "ANALOG" : "INPUT"), defaults.value ?? 0,
      defaults.lowLabel ?? null, defaults.highLabel ?? null, defaults.unit ?? null, defaults.lowIn ?? null, defaults.lowOut ?? null,
      defaults.highIn ?? null, defaults.highOut ?? null, defaults.safe ?? null, now));
  }
  await db.batch(statements);
  const created = await getDevice(db, id);
  if (!created) throw new Error("Simulator was not created");
  return created;
}

export async function setConnectionState(db: DatabaseBinding, id: string, state: DeviceState, reason: string) {
  const now = Date.now();
  const stateFields = state === "ONLINE" ? { seen: now, connected: now, disconnected: null, rssi: -54, ip: "192.168.1.81" } : state === "OFFLINE" ? { seen: null, connected: null, disconnected: now, rssi: null, ip: null } : { seen: null, connected: null, disconnected: null, rssi: null, ip: null };
  await db.batch([
    db.prepare(`
      UPDATE devices SET connection_state = ?, last_seen_at = COALESCE(?, last_seen_at),
        last_connected_at = COALESCE(?, last_connected_at), last_disconnected_at = COALESCE(?, last_disconnected_at),
        rssi_dbm = ?, ip_address = ?, updated_at = ? WHERE id = ?
    `).bind(state, stateFields.seen, stateFields.connected, stateFields.disconnected, stateFields.rssi, stateFields.ip, now, id),
    db.prepare("INSERT INTO device_connection_events (device_id, state, reason, occurred_at) VALUES (?, ?, ?, ?)").bind(id, state, reason.slice(0, 160), now),
  ]);
  return getDevice(db, id);
}
