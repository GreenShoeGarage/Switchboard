import type { DatabaseBinding } from "@/db";
import { getBoardProfile } from "@/lib/board-profiles";
import {
  GPIO_COMMAND_TIMEOUT_MS,
  type GpioCommandKind,
  type GpioCommandRecord,
  type PinMode,
} from "@/lib/device-model";
import { getDevice, getDevicePins } from "@/lib/registry-server";

type Row = Record<string, unknown>;
export type IssueInput = {
  deviceId: string;
  pinId: string;
  kind: GpioCommandKind;
  requestedMode?: PinMode;
  requestedValue?: number;
  actor: string;
  origin?: "OPERATOR" | "SERVER_SAFE_STATE" | "AUTOMATION";
  safeStateRunId?: string | null;
  automationRuleId?: string | null;
  automationRuleRevision?: number | null;
  automationActionId?: string | null;
  automationExecutionId?: string | null;
};
type AckInput = {
  deviceId: string;
  sessionId?: string | null;
  commandId: string;
  pinId: string;
  confirmedMode: string;
  confirmedValue: number;
  deviceTimestampMs?: number;
  error?: string;
};

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function stringOrNull(value: unknown) { return typeof value === "string" ? value : null; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }

export function mapGpioCommand(row: Row): GpioCommandRecord {
  return {
    id: text(row.id), deviceId: text(row.device_id), pinId: text(row.pin_id),
    kind: text(row.kind) as GpioCommandRecord["kind"],
    origin: text(row.origin || "OPERATOR") as GpioCommandRecord["origin"],
    safeStateRunId: stringOrNull(row.safe_state_run_id),
    automationRuleId: stringOrNull(row.automation_rule_id),
    automationRuleRevision: numberOrNull(row.automation_rule_revision),
    automationActionId: stringOrNull(row.automation_action_id),
    automationExecutionId: stringOrNull(row.automation_execution_id),
    requestedMode: stringOrNull(row.requested_mode) as GpioCommandRecord["requestedMode"],
    requestedValue: numberOrNull(row.requested_value),
    status: text(row.status) as GpioCommandRecord["status"], actor: text(row.actor),
    requestedAt: Number(row.requested_at), deadlineAt: Number(row.deadline_at),
    deliveredAt: numberOrNull(row.delivered_at), completedAt: numberOrNull(row.completed_at),
    sessionId: stringOrNull(row.session_id),
    confirmedMode: stringOrNull(row.confirmed_mode) as GpioCommandRecord["confirmedMode"],
    confirmedValue: numberOrNull(row.confirmed_value),
    deviceTimestampMs: numberOrNull(row.device_timestamp_ms), latencyMs: numberOrNull(row.latency_ms),
    error: text(row.error),
  };
}

export async function expireGpioCommands(db: DatabaseBinding, deviceId?: string) {
  const now = Date.now();
  const statement = deviceId
    ? db.prepare(`UPDATE gpio_commands SET status = 'TIMED_OUT', completed_at = ?, error = 'Acknowledgment timeout'
        WHERE device_id = ? AND status IN ('QUEUED', 'DELIVERED') AND deadline_at <= ?`).bind(now, deviceId, now)
    : db.prepare(`UPDATE gpio_commands SET status = 'TIMED_OUT', completed_at = ?, error = 'Acknowledgment timeout'
        WHERE status IN ('QUEUED', 'DELIVERED') AND deadline_at <= ?`).bind(now, now);
  const result = await statement.run();
  await db.prepare(`UPDATE automation_action_runs SET status = 'TIMED_OUT', completed_at = ?, error = 'Acknowledgment timeout'
    WHERE gpio_command_id IN (SELECT id FROM gpio_commands WHERE status = 'TIMED_OUT')
      AND status IN ('QUEUED', 'DELIVERED')`).bind(now).run();
  await db.prepare(`UPDATE automation_executions SET status = 'TIMED_OUT', completed_at = ?, reason = 'One or more automation commands timed out'
    WHERE id IN (SELECT execution_id FROM automation_action_runs WHERE status = 'TIMED_OUT')
      AND status IN ('QUEUED', 'RUNNING')`).bind(now).run();
  return result;
}

export async function listGpioCommands(db: DatabaseBinding, deviceId: string, limit = 40) {
  await expireGpioCommands(db, deviceId);
  const boundedLimit = Math.max(1, Math.min(100, Math.round(limit)));
  const result = await db.prepare(`SELECT * FROM gpio_commands WHERE device_id = ?
    ORDER BY requested_at DESC LIMIT ?`).bind(deviceId, boundedLimit).all<Row>();
  return (result.results ?? []).map(mapGpioCommand);
}

export async function getGpioCommand(db: DatabaseBinding, deviceId: string, commandId: string) {
  await expireGpioCommands(db, deviceId);
  const row = await db.prepare("SELECT * FROM gpio_commands WHERE id = ? AND device_id = ?")
    .bind(commandId, deviceId).first<Row>();
  return row ? mapGpioCommand(row) : null;
}

export async function issueGpioCommand(db: DatabaseBinding, input: IssueInput) {
  await expireGpioCommands(db, input.deviceId);
  const device = await getDevice(db, input.deviceId);
  if (!device) throw new Error("Device not found");
  if (device.connectionState !== "ONLINE") throw new Error("DEVICE_OFFLINE");
  if (!device.controlReady && !device.simulated) throw new Error("DEVICE_NOT_SYNCHRONIZED");
  if (device.maintenanceMode) throw new Error("DEVICE_IN_MAINTENANCE");
  if (device.monitorOnly) throw new Error("DEVICE_MONITOR_ONLY");
  const pinId = input.pinId.trim().slice(0, 8);
  const pins = await getDevicePins(db, input.deviceId);
  const pin = pins.find((candidate) => candidate.pinId === pinId);
  if (!pin) throw new Error("Pin not found in device profile");
  const profilePin = getBoardProfile(device.boardProfileId)?.pins.find((candidate) => candidate.id === pinId);
  if (!profilePin) throw new Error("Pin profile is unavailable");

  let requestedMode: PinMode | null = null;
  let requestedValue: number | null = null;
  if (input.kind === "WRITE") {
    if (pin.mode !== "OUTPUT" || !profilePin.capabilities.includes("digital-output")) throw new Error("Pin is not configured as a digital output");
    if (input.requestedValue !== 0 && input.requestedValue !== 1) throw new Error("Digital output value must be 0 or 1");
    requestedValue = input.requestedValue;
  } else if (input.kind === "WRITE_PWM") {
    if (pin.mode !== "PWM" || !profilePin.capabilities.includes("pwm")) throw new Error("Pin is not configured as a PWM output");
    if (!Number.isInteger(input.requestedValue) || input.requestedValue! < 0 || input.requestedValue! > 4095) throw new Error("PWM output value must be a 12-bit integer from 0 to 4095");
    requestedValue = input.requestedValue!;
  } else if (input.kind === "WRITE_DAC") {
    if (pin.mode !== "DAC" || !profilePin.capabilities.includes("dac-output")) throw new Error("Pin is not configured as a DAC output");
    if (!Number.isInteger(input.requestedValue) || input.requestedValue! < 0 || input.requestedValue! > 4095) throw new Error("DAC output value must be a 12-bit integer from 0 to 4095");
    requestedValue = input.requestedValue!;
  } else if (input.kind === "SET_MODE") {
    const mode = input.requestedMode;
    if (!mode || !["INPUT", "INPUT_PULLUP", "OUTPUT", "ANALOG", "PWM", "DAC"].includes(mode)) throw new Error("Unsupported pin mode");
    if ((mode === "INPUT" || mode === "INPUT_PULLUP") && !profilePin.capabilities.includes("digital-input")) throw new Error("Pin does not support digital input");
    if (mode === "OUTPUT" && !profilePin.capabilities.includes("digital-output")) throw new Error("Pin does not support digital output");
    if (mode === "ANALOG" && !profilePin.capabilities.includes("analog-input")) throw new Error("Pin does not support analog input");
    if (mode === "PWM" && !profilePin.capabilities.includes("pwm")) throw new Error("Pin does not support PWM output");
    if (mode === "DAC" && !profilePin.capabilities.includes("dac-output")) throw new Error("Pin does not support DAC output");
    requestedMode = mode;
  } else {
    throw new Error("Unsupported GPIO command kind");
  }

  const now = Date.now();
  const id = `CMD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const actor = input.actor.trim().slice(0, 120) || "owner";
  const insert = db.prepare(`
    INSERT INTO gpio_commands (id, device_id, pin_id, kind, origin, safe_state_run_id, automation_rule_id,
      automation_rule_revision, automation_action_id, automation_execution_id, requested_mode, requested_value,
      status, actor, requested_at, deadline_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ? FROM devices device
    JOIN device_pins current_pin ON current_pin.device_id = device.id AND current_pin.pin_id = ?
    WHERE device.id = ? AND current_pin.mode = ? AND device.connection_state = 'ONLINE' AND (device.simulated = 1 OR device.control_ready = 1) AND device.maintenance_mode = 0 AND device.monitor_only = 0
    AND (? <> 'AUTOMATION' OR (
      device.automation_armed = 1
      AND NOT EXISTS (SELECT 1 FROM gpio_commands safe_command WHERE safe_command.device_id = device.id
        AND safe_command.origin = 'SERVER_SAFE_STATE' AND safe_command.status IN ('QUEUED', 'DELIVERED'))
      AND (device.simulated = 1 OR EXISTS (SELECT 1 FROM hardware_test_runs run WHERE run.device_id = device.id
        AND run.status = 'PASSED' AND run.agent_version = device.agent_version
        AND run.validated_configuration_version = device.configuration_version
        AND COALESCE(run.validated_firmware_version, '') = COALESCE(device.firmware_version, '')
        AND run.completed_cycles >= run.target_cycles AND run.failure_count = 0))
      AND EXISTS (
        SELECT 1 FROM automation_rules rule JOIN automation_executions execution ON execution.rule_id = rule.id
        WHERE rule.id = ? AND rule.revision = ? AND rule.mode = 'LIVE' AND rule.approved_revision = rule.revision
          AND (device.simulated = 1 OR rule.action_scope = 'PHYSICAL_CONTROL')
          AND execution.id = ? AND execution.rule_revision = rule.revision AND execution.status IN ('QUEUED', 'RUNNING')
          AND EXISTS (SELECT 1 FROM automation_actions action WHERE action.id = ? AND action.rule_id = rule.id
            AND action.target_device_id = device.id AND action.target_pin_id = current_pin.pin_id
            AND action.target_configuration_version = device.configuration_version AND action.command_kind = ?
            AND action.requested_value = ?)
      )
    ))
    AND NOT EXISTS (
      SELECT 1 FROM gpio_commands
      WHERE device_id = ? AND pin_id = ? AND status IN ('QUEUED', 'DELIVERED') AND deadline_at > ?
    )
  `).bind(id, input.deviceId, pinId, input.kind, input.origin ?? "OPERATOR", input.safeStateRunId ?? null,
    input.automationRuleId ?? null, input.automationRuleRevision ?? null, input.automationActionId ?? null,
    input.automationExecutionId ?? null, requestedMode, requestedValue, actor, now, now + GPIO_COMMAND_TIMEOUT_MS,
    pinId, input.deviceId, pin.mode, input.origin ?? "OPERATOR", input.automationRuleId ?? null,
    input.automationRuleRevision ?? null, input.automationExecutionId ?? null, input.automationActionId ?? null,
    input.kind, requestedValue, input.deviceId, pinId, now);
  await db.batch([
    insert,
    db.prepare(`UPDATE automation_action_runs SET status = 'QUEUED', gpio_command_id = ?, started_at = ?, error = ''
      WHERE execution_id = ? AND action_id = ? AND status = 'PLANNED'
        AND EXISTS (SELECT 1 FROM gpio_commands WHERE id = ? AND origin = 'AUTOMATION')`)
      .bind(id, now, input.automationExecutionId ?? null, input.automationActionId ?? null, id),
  ]);
  const row = await db.prepare("SELECT * FROM gpio_commands WHERE id = ?").bind(id).first<Row>();
  if (!row) {
    const latest = await getDevice(db, input.deviceId);
    if (latest?.maintenanceMode) throw new Error("DEVICE_IN_MAINTENANCE");
    if (latest?.monitorOnly) throw new Error("DEVICE_MONITOR_ONLY");
    if (latest?.connectionState !== "ONLINE") throw new Error("DEVICE_OFFLINE");
    if (!latest?.controlReady && !latest?.simulated) throw new Error("DEVICE_NOT_SYNCHRONIZED");
    throw new Error("PIN_COMMAND_PENDING");
  }
  return mapGpioCommand(row);
}

export async function claimNextGpioCommand(db: DatabaseBinding, deviceId: string, sessionId: string) {
  await expireGpioCommands(db, deviceId);
  const now = Date.now();
  const row = await db.prepare(`
    UPDATE gpio_commands SET status = 'DELIVERED', delivered_at = ?, session_id = ?
    WHERE id = (
      SELECT command.id FROM gpio_commands command JOIN devices device ON device.id = command.device_id
      WHERE command.device_id = ? AND command.status = 'QUEUED' AND command.deadline_at > ?
        AND device.connection_state = 'ONLINE' AND (device.simulated = 1 OR device.control_ready = 1) AND device.maintenance_mode = 0 AND device.monitor_only = 0
        AND (command.origin <> 'AUTOMATION' OR (
          device.automation_armed = 1
          AND NOT EXISTS (SELECT 1 FROM gpio_commands safe_command WHERE safe_command.device_id = device.id
            AND safe_command.origin = 'SERVER_SAFE_STATE' AND safe_command.status IN ('QUEUED', 'DELIVERED'))
          AND (device.simulated = 1 OR EXISTS (SELECT 1 FROM hardware_test_runs run WHERE run.device_id = device.id
            AND run.status = 'PASSED' AND run.agent_version = device.agent_version
            AND run.validated_configuration_version = device.configuration_version
            AND COALESCE(run.validated_firmware_version, '') = COALESCE(device.firmware_version, '')
            AND run.completed_cycles >= run.target_cycles AND run.failure_count = 0))
          AND EXISTS (
            SELECT 1 FROM automation_rules rule JOIN automation_executions execution ON execution.rule_id = rule.id
            WHERE rule.id = command.automation_rule_id AND rule.revision = command.automation_rule_revision
              AND rule.mode = 'LIVE' AND rule.approved_revision = rule.revision
              AND (device.simulated = 1 OR rule.action_scope = 'PHYSICAL_CONTROL')
              AND execution.id = command.automation_execution_id AND execution.rule_revision = rule.revision
              AND execution.status IN ('QUEUED', 'RUNNING')
              AND EXISTS (SELECT 1 FROM automation_actions action WHERE action.id = command.automation_action_id
                AND action.rule_id = rule.id AND action.target_device_id = device.id AND action.target_pin_id = command.pin_id
                AND action.target_configuration_version = device.configuration_version AND action.command_kind = command.kind
                AND action.requested_value = command.requested_value)
          )
        ))
        AND (device.simulated = 1 OR EXISTS (
          SELECT 1 FROM device_sessions session
          WHERE session.id = ? AND session.device_id = device.id AND session.state = 'CONNECTED'
            AND EXISTS (SELECT 1 FROM device_credentials credential WHERE credential.id = session.credential_id AND credential.revoked_at IS NULL)
            AND EXISTS (SELECT 1 FROM device_state_snapshots snapshot WHERE snapshot.session_id = session.id)
        ))
      ORDER BY CASE command.origin WHEN 'SERVER_SAFE_STATE' THEN 0 WHEN 'OPERATOR' THEN 1 ELSE 2 END, requested_at ASC LIMIT 1
    ) AND status = 'QUEUED'
    RETURNING *
  `).bind(now, sessionId, deviceId, now, sessionId).first<Row>();
  if (row?.automation_execution_id) await db.batch([
    db.prepare(`UPDATE automation_action_runs SET status = 'DELIVERED', started_at = COALESCE(started_at, ?)
      WHERE gpio_command_id = ? AND status = 'QUEUED'`).bind(now, row.id),
    db.prepare(`UPDATE automation_executions SET status = 'RUNNING', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'QUEUED'`).bind(now, row.automation_execution_id),
  ]);
  return row ? mapGpioCommand(row) : null;
}

async function failGpioCommand(db: DatabaseBinding, command: GpioCommandRecord, error: string) {
  const now = Date.now();
  await db.prepare(`UPDATE gpio_commands SET status = 'FAILED', completed_at = ?, error = ?
    WHERE id = ? AND status = 'DELIVERED'`).bind(now, error.slice(0, 180), command.id).run();
  await db.prepare(`UPDATE automation_action_runs SET status = 'FAILED', completed_at = ?, error = ?
    WHERE gpio_command_id = ? AND status IN ('QUEUED', 'DELIVERED')`).bind(now, error.slice(0, 180), command.id).run();
  if (command.automationExecutionId) await db.prepare(`UPDATE automation_executions SET status = 'FAILED', completed_at = ?, reason = ?
    WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`).bind(now, error.slice(0, 180), command.automationExecutionId).run();
  return getGpioCommand(db, command.deviceId, command.id);
}

export async function acknowledgeGpioCommand(db: DatabaseBinding, input: AckInput) {
  await expireGpioCommands(db, input.deviceId);
  const row = await db.prepare("SELECT * FROM gpio_commands WHERE id = ? AND device_id = ?")
    .bind(input.commandId, input.deviceId).first<Row>();
  if (!row) throw new Error("GPIO command not found");
  const command = mapGpioCommand(row);
  if (command.status !== "DELIVERED") throw new Error(`GPIO command is ${command.status.toLowerCase()}`);
  if (input.sessionId && command.sessionId !== input.sessionId) throw new Error("GPIO acknowledgment came from the wrong session");
  if (input.pinId !== command.pinId) return failGpioCommand(db, command, "Acknowledgment pin did not match request");
  if (input.error) return failGpioCommand(db, command, `Device rejected command: ${input.error}`);
  if (!Number.isFinite(input.confirmedValue)) return failGpioCommand(db, command, "Acknowledgment value was invalid");

  const pins = await getDevicePins(db, input.deviceId);
  const pin = pins.find((candidate) => candidate.pinId === command.pinId);
  if (!pin) return failGpioCommand(db, command, "Acknowledged pin no longer exists");
  if (command.kind === "WRITE" || command.kind === "WRITE_PWM" || command.kind === "WRITE_DAC") {
    const expectedMode = command.kind === "WRITE" ? "OUTPUT" : command.kind === "WRITE_PWM" ? "PWM" : "DAC";
    if (input.confirmedMode !== expectedMode || input.confirmedValue !== command.requestedValue) {
      return failGpioCommand(db, command, "Acknowledgment state did not match requested output");
    }
  } else if (input.confirmedMode !== command.requestedMode) {
    return failGpioCommand(db, command, "Acknowledgment mode did not match request");
  }
  if (["INPUT", "INPUT_PULLUP", "OUTPUT"].includes(input.confirmedMode) && input.confirmedValue !== 0 && input.confirmedValue !== 1) {
    return failGpioCommand(db, command, "Acknowledgment digital value was not 0 or 1");
  }
  if ((input.confirmedMode === "PWM" || input.confirmedMode === "DAC") && (!Number.isInteger(input.confirmedValue) || input.confirmedValue < 0 || input.confirmedValue > 4095)) {
    return failGpioCommand(db, command, "Acknowledgment modulated value was not a 12-bit integer");
  }

  const now = Date.now();
  const confirmedMode = input.confirmedMode as PinMode;
  const confirmedValue = command.kind === "SET_MODE" && confirmedMode === "ANALOG" ? pin.confirmedValue : input.confirmedValue;
  const confirmedRawValue = confirmedMode === "ANALOG" ? input.confirmedValue : null;
  const latencyMs = Math.max(0, now - command.requestedAt);
  await db.batch([
    db.prepare(`UPDATE gpio_commands SET status = 'ACKNOWLEDGED', completed_at = ?, confirmed_mode = ?,
      confirmed_value = ?, device_timestamp_ms = ?, latency_ms = ?, error = ''
      WHERE id = ? AND status = 'DELIVERED' AND deadline_at > ?
    `).bind(now, confirmedMode, input.confirmedValue, input.deviceTimestampMs ?? null, latencyMs, command.id, now),
    db.prepare(`UPDATE device_pins SET mode = ?, confirmed_value = ?, confirmed_raw_value = ?, sampled_at = ?,
      server_safe_value = CASE WHEN ? = 'SET_MODE' THEN NULL ELSE server_safe_value END, updated_at = ?
      WHERE device_id = ? AND pin_id = ? AND EXISTS (
        SELECT 1 FROM gpio_commands WHERE id = ? AND status = 'ACKNOWLEDGED'
      )`).bind(command.kind === "SET_MODE" ? confirmedMode : pin.mode, confirmedValue, confirmedRawValue,
      confirmedMode === "ANALOG" ? now : null, command.kind, now, input.deviceId, command.pinId, command.id),
    db.prepare(`UPDATE devices SET last_seen_at = ?, configuration_version = configuration_version + CASE WHEN ? = 'SET_MODE' THEN 1 ELSE 0 END,
      automation_armed = CASE WHEN ? = 'SET_MODE' THEN 0 ELSE automation_armed END, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM gpio_commands WHERE id = ? AND status = 'ACKNOWLEDGED')`).bind(now, command.kind, command.kind, now, input.deviceId, command.id),
    db.prepare(`UPDATE automation_action_runs SET status = 'ACKNOWLEDGED', completed_at = ?, error = ''
      WHERE gpio_command_id = ? AND EXISTS (SELECT 1 FROM gpio_commands WHERE id = ? AND status = 'ACKNOWLEDGED')`).bind(now, command.id, command.id),
    db.prepare(`UPDATE automation_executions SET status = 'ACKNOWLEDGED', completed_at = ?, reason = 'All automation commands were acknowledged'
      WHERE id = ? AND ? IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM automation_action_runs WHERE execution_id = ? AND status <> 'ACKNOWLEDGED'
      )`).bind(now, command.automationExecutionId, command.automationExecutionId, command.automationExecutionId),
  ]);
  if (command.kind === "SET_MODE") {
    const { cancelQueuedAutomationForDevice } = await import("@/lib/automation-server");
    await cancelQueuedAutomationForDevice(db, input.deviceId, "Device pin configuration changed", undefined, now);
  }
  return getGpioCommand(db, input.deviceId, command.id);
}

export async function executeServerSimulatorCommand(db: DatabaseBinding, deviceId: string, commandId: string) {
  const deliveredAt = Date.now();
  const row = await db.prepare(`UPDATE gpio_commands SET status = 'DELIVERED', delivered_at = ?
    WHERE id = ? AND device_id = ? AND status = 'QUEUED' AND EXISTS (
      SELECT 1 FROM devices device WHERE device.id = ? AND device.connection_state = 'ONLINE' AND (device.simulated = 1 OR device.control_ready = 1) AND device.maintenance_mode = 0 AND device.monitor_only = 0
        AND (gpio_commands.origin <> 'AUTOMATION' OR (device.automation_armed = 1
          AND NOT EXISTS (SELECT 1 FROM gpio_commands safe_command WHERE safe_command.device_id = device.id
            AND safe_command.origin = 'SERVER_SAFE_STATE' AND safe_command.status IN ('QUEUED', 'DELIVERED'))
          AND (device.simulated = 1 OR EXISTS (SELECT 1 FROM hardware_test_runs run WHERE run.device_id = device.id
            AND run.status = 'PASSED' AND run.agent_version = device.agent_version
            AND run.validated_configuration_version = device.configuration_version
            AND COALESCE(run.validated_firmware_version, '') = COALESCE(device.firmware_version, '')
            AND run.completed_cycles >= run.target_cycles AND run.failure_count = 0))
          AND EXISTS (
          SELECT 1 FROM automation_rules rule JOIN automation_executions execution ON execution.rule_id = rule.id
          WHERE rule.id = gpio_commands.automation_rule_id AND rule.revision = gpio_commands.automation_rule_revision
            AND rule.mode = 'LIVE' AND rule.approved_revision = rule.revision
            AND (device.simulated = 1 OR rule.action_scope = 'PHYSICAL_CONTROL')
            AND execution.id = gpio_commands.automation_execution_id AND execution.status IN ('QUEUED', 'RUNNING')
            AND EXISTS (SELECT 1 FROM automation_actions action WHERE action.id = gpio_commands.automation_action_id
              AND action.rule_id = rule.id AND action.target_device_id = device.id AND action.target_pin_id = gpio_commands.pin_id
              AND action.target_configuration_version = device.configuration_version AND action.command_kind = gpio_commands.kind
              AND action.requested_value = gpio_commands.requested_value)
        )))
    ) RETURNING *`).bind(deliveredAt, commandId, deviceId, deviceId).first<Row>();
  if (row?.automation_execution_id) await db.batch([
    db.prepare(`UPDATE automation_action_runs SET status = 'DELIVERED', started_at = COALESCE(started_at, ?) WHERE gpio_command_id = ? AND status = 'QUEUED'`).bind(deliveredAt, commandId),
    db.prepare(`UPDATE automation_executions SET status = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'QUEUED'`).bind(deliveredAt, row.automation_execution_id),
  ]);
  if (!row) throw new Error("Simulator command could not be delivered");
  const command = mapGpioCommand(row);
  await new Promise((resolve) => setTimeout(resolve, 65 + Math.random() * 55));
  const pin = (await getDevicePins(db, deviceId)).find((candidate) => candidate.pinId === command.pinId);
  if (!pin) throw new Error("Simulator pin is unavailable");
  const modeValue = command.requestedMode === "OUTPUT" || command.requestedMode === "PWM" || command.requestedMode === "DAC" ? 0
    : command.requestedMode === "ANALOG" ? pin.confirmedRawValue ?? 0
    : pin.confirmedValue === 0 || pin.confirmedValue === 1 ? pin.confirmedValue : 0;
  return acknowledgeGpioCommand(db, {
    deviceId, commandId, pinId: command.pinId,
    confirmedMode: command.requestedMode ?? pin.mode,
    confirmedValue: command.kind === "WRITE" || command.kind === "WRITE_PWM" || command.kind === "WRITE_DAC" ? command.requestedValue ?? 0 : modeValue,
    deviceTimestampMs: Date.now(),
  });
}
