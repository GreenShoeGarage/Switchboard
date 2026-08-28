import type { DatabaseBinding, DatabaseStatement } from "@/db";
import { cancelQueuedAutomationForDevice } from "@/lib/automation-server";
import { GPIO_COMMAND_TIMEOUT_MS, type SafeStateRunRecord, type SafeStateRunStatus } from "@/lib/device-model";
import { expireGpioCommands, mapGpioCommand } from "@/lib/gpio-server";
import { getDevice, getDevicePins } from "@/lib/registry-server";

type Row = Record<string, unknown>;

function mapRun(row: Row): SafeStateRunRecord {
  return {
    id: String(row.id), deviceId: String(row.device_id), actor: String(row.actor),
    status: String(row.status) as SafeStateRunStatus, targetCount: Number(row.target_count),
    acknowledgedCount: Number(row.acknowledged_count ?? 0), failedCount: Number(row.failed_count ?? 0),
    requestedAt: Number(row.requested_at), completedAt: typeof row.completed_at === "number" ? row.completed_at : null,
  };
}

async function runWithCounts(db: DatabaseBinding, deviceId: string, runId: string) {
  return db.prepare(`SELECT run.*,
      COALESCE(SUM(CASE WHEN command.status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END), 0) AS acknowledged_count,
      COALESCE(SUM(CASE WHEN command.status IN ('FAILED', 'TIMED_OUT') THEN 1 ELSE 0 END), 0) AS failed_count,
      COALESCE(SUM(CASE WHEN command.status = 'TIMED_OUT' THEN 1 ELSE 0 END), 0) AS timed_out_count,
      COALESCE(SUM(CASE WHEN command.status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS delivered_count,
      COALESCE(SUM(CASE WHEN command.status = 'QUEUED' THEN 1 ELSE 0 END), 0) AS queued_count,
      COUNT(command.id) AS command_count
    FROM device_safe_state_runs run LEFT JOIN gpio_commands command ON command.safe_state_run_id = run.id
    WHERE run.id = ? AND run.device_id = ? GROUP BY run.id
  `).bind(runId, deviceId).first<Row>();
}

export async function refreshSafeStateRun(db: DatabaseBinding, deviceId: string, runId: string) {
  await expireGpioCommands(db, deviceId);
  const row = await runWithCounts(db, deviceId, runId);
  if (!row) return null;
  const acknowledged = Number(row.acknowledged_count ?? 0);
  const failed = Number(row.failed_count ?? 0);
  const timedOut = Number(row.timed_out_count ?? 0);
  const delivered = Number(row.delivered_count ?? 0);
  const queued = Number(row.queued_count ?? 0);
  const commandCount = Number(row.command_count ?? 0);
  const target = Number(row.target_count);
  const active = queued + delivered;
  const explicitlyFailed = row.status === "FAILED" && commandCount !== target;
  const status: SafeStateRunStatus = explicitlyFailed ? "FAILED"
    : active > 0 && (delivered > 0 || acknowledged > 0 || failed > 0 || timedOut > 0) ? "RUNNING"
    : active > 0 ? "QUEUED"
    : timedOut > 0 ? "TIMED_OUT"
    : failed > 0 ? "FAILED"
    : target > 0 && acknowledged === target ? "ACKNOWLEDGED"
    : "QUEUED";
  const terminal = status === "ACKNOWLEDGED" || status === "FAILED" || status === "TIMED_OUT";
  if (status !== row.status || terminal && row.completed_at === null) {
    await db.prepare(`UPDATE device_safe_state_runs SET status = ?, completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ? AND device_id = ?`)
      .bind(status, terminal ? 1 : 0, Date.now(), runId, deviceId).run();
  }
  return mapRun({ ...row, status, completed_at: terminal ? Number(row.completed_at ?? Date.now()) : null });
}

export async function listSafeStateRuns(db: DatabaseBinding, deviceId: string, limit = 12) {
  const bounded = Math.max(1, Math.min(40, Number.isFinite(limit) ? Math.round(limit) : 12));
  const result = await db.prepare(`SELECT id FROM device_safe_state_runs WHERE device_id = ? ORDER BY requested_at DESC LIMIT ?`)
    .bind(deviceId, bounded).all<Row>();
  const runs: SafeStateRunRecord[] = [];
  for (const row of result.results ?? []) {
    const run = await refreshSafeStateRun(db, deviceId, String(row.id));
    if (run) runs.push(run);
  }
  return runs;
}

export async function listSafeStateCommands(db: DatabaseBinding, deviceId: string, runId: string) {
  const result = await db.prepare(`SELECT * FROM gpio_commands WHERE device_id = ? AND safe_state_run_id = ? ORDER BY requested_at, pin_id`)
    .bind(deviceId, runId).all<Row>();
  return (result.results ?? []).map(mapGpioCommand);
}

export async function createSafeStateRun(db: DatabaseBinding, input: { deviceId: string; actor: string }) {
  const device = await getDevice(db, input.deviceId);
  if (!device) throw new Error("Device not found");
  if (device.connectionState !== "ONLINE") throw new Error("DEVICE_OFFLINE");
  if (!device.controlReady && !device.simulated) throw new Error("DEVICE_NOT_SYNCHRONIZED");
  if (device.maintenanceMode) throw new Error("DEVICE_IN_MAINTENANCE");
  if (device.monitorOnly) throw new Error("DEVICE_MONITOR_ONLY");
  let pins = (await getDevicePins(db, input.deviceId)).filter((pin) => pin.serverSafeValue !== null && ["OUTPUT", "PWM", "DAC"].includes(pin.mode));
  if (!pins.length) throw new Error("SAFE_STATE_NOT_CONFIGURED");
  for (const pin of pins) {
    if (pin.mode === "OUTPUT" && pin.serverSafeValue !== 0 && pin.serverSafeValue !== 1) throw new Error(`Invalid digital safe state for ${pin.pinId}`);
    if ((pin.mode === "PWM" || pin.mode === "DAC") && (!Number.isInteger(pin.serverSafeValue) || pin.serverSafeValue! < 0 || pin.serverSafeValue! > 4095)) throw new Error(`Invalid 12-bit safe state for ${pin.pinId}`);
  }
  const now = Date.now();
  const runId = `SAFE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const actor = input.actor.trim().slice(0, 120) || "owner";
  await db.prepare(`UPDATE device_safe_state_runs SET status = 'FAILED', completed_at = ?
    WHERE device_id = ? AND status IN ('QUEUED', 'RUNNING')
      AND NOT EXISTS (SELECT 1 FROM gpio_commands command WHERE command.safe_state_run_id = device_safe_state_runs.id)`)
    .bind(now, input.deviceId).run();
  const active = await db.prepare(`SELECT run.id FROM device_safe_state_runs run JOIN gpio_commands command ON command.safe_state_run_id = run.id
    WHERE run.device_id = ? AND command.status IN ('QUEUED', 'DELIVERED') LIMIT 1`).bind(input.deviceId).first<Row>();
  if (active) throw new Error("SAFE_STATE_ALREADY_ACTIVE");
  await db.prepare(`INSERT INTO device_safe_state_runs (id, device_id, actor, status, target_count, requested_at) VALUES (?, ?, ?, 'QUEUED', ?, ?)`)
    .bind(runId, input.deviceId, actor, pins.length, now).run();
  await cancelQueuedAutomationForDevice(db, input.deviceId, "Server safe state preempted queued automation", pins.map((pin) => pin.pinId));
  pins = (await getDevicePins(db, input.deviceId)).filter((pin) => pin.serverSafeValue !== null && ["OUTPUT", "PWM", "DAC"].includes(pin.mode));
  if (pins.some((pin) => pin.pendingCommandId)) {
    await db.prepare("UPDATE device_safe_state_runs SET status = 'FAILED', completed_at = ? WHERE id = ?").bind(now, runId).run();
    throw new Error("PIN_COMMAND_PENDING");
  }
  const statements: DatabaseStatement[] = [];
  for (const [index, pin] of pins.entries()) {
    const commandId = `CMD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    const kind = pin.mode === "OUTPUT" ? "WRITE" : pin.mode === "PWM" ? "WRITE_PWM" : "WRITE_DAC";
    statements.push(db.prepare(`INSERT INTO gpio_commands
      (id, device_id, pin_id, kind, origin, safe_state_run_id, requested_value, status, actor, requested_at, deadline_at)
      SELECT ?, ?, ?, ?, 'SERVER_SAFE_STATE', ?, ?, 'QUEUED', ?, ?, ? FROM devices device
      JOIN device_pins current_pin ON current_pin.device_id = device.id AND current_pin.pin_id = ?
      WHERE device.id = ? AND current_pin.mode = ? AND current_pin.server_safe_value = ?
        AND device.connection_state = 'ONLINE' AND (device.simulated = 1 OR device.control_ready = 1) AND device.maintenance_mode = 0 AND device.monitor_only = 0
        AND NOT EXISTS (SELECT 1 FROM gpio_commands WHERE device_id = ? AND pin_id = ? AND status IN ('QUEUED', 'DELIVERED') AND deadline_at > ?)
    `).bind(commandId, input.deviceId, pin.pinId, kind, runId, pin.serverSafeValue, actor, now, now + GPIO_COMMAND_TIMEOUT_MS + index * 500,
      pin.pinId, input.deviceId, pin.mode, pin.serverSafeValue, input.deviceId, pin.pinId, now));
  }
  statements.push(
    db.prepare(`UPDATE device_safe_state_runs SET status = 'FAILED', completed_at = ? WHERE id = ?
      AND (SELECT count(*) FROM gpio_commands WHERE safe_state_run_id = ?) <> target_count`).bind(now, runId, runId),
    db.prepare(`UPDATE gpio_commands SET status = 'FAILED', completed_at = ?, error = 'Safe-state batch failed before delivery'
      WHERE safe_state_run_id = ? AND status = 'QUEUED'
        AND EXISTS (SELECT 1 FROM device_safe_state_runs WHERE id = ? AND status = 'FAILED')`).bind(now, runId, runId),
  );
  try { await db.batch(statements); }
  catch (error) {
    await db.prepare("UPDATE device_safe_state_runs SET status = 'FAILED', completed_at = ? WHERE id = ?").bind(Date.now(), runId).run();
    throw error;
  }
  const run = await refreshSafeStateRun(db, input.deviceId, runId);
  if (!run || run.status === "FAILED") throw new Error("SAFE_STATE_QUEUE_FAILED");
  return { run, commands: await listSafeStateCommands(db, input.deviceId, runId) };
}
