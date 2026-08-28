import type { DatabaseBinding, DatabaseStatement } from "@/db";
import {
  HIL_STEP_KEYS,
  type HilRunRecord,
  type HilRunStatus,
  type HilStepKey,
  type HilStepRecord,
  type HilStepStatus,
} from "@/lib/device-model";
import { getDevice } from "@/lib/registry-server";

type Row = Record<string, unknown>;

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }

function mapStep(row: Row): HilStepRecord {
  return {
    runId: text(row.run_id), stepKey: text(row.step_key) as HilStepKey,
    status: text(row.status) as HilStepStatus, observation: text(row.observation),
    updatedAt: Number(row.updated_at),
  };
}

function mapRun(row: Row, steps: HilStepRecord[]): HilRunRecord {
  return {
    id: text(row.id), deviceId: text(row.device_id), status: text(row.status) as HilRunStatus,
    agentVersion: text(row.agent_version), validatedConfigurationVersion: Number(row.validated_configuration_version),
    validatedFirmwareVersion: typeof row.validated_firmware_version === "string" ? row.validated_firmware_version : null, fixture: text(row.fixture),
    targetCycles: Number(row.target_cycles), completedCycles: Number(row.completed_cycles),
    failureCount: Number(row.failure_count), operator: text(row.operator), notes: text(row.notes),
    startedAt: Number(row.started_at), completedAt: numberOrNull(row.completed_at), steps,
  };
}

async function loadSteps(db: DatabaseBinding, runId: string) {
  const result = await db.prepare(`SELECT * FROM hardware_test_steps WHERE run_id = ? ORDER BY rowid`).bind(runId).all<Row>();
  return (result.results ?? []).map(mapStep);
}

export async function getHilRun(db: DatabaseBinding, deviceId: string, runId: string) {
  const row = await db.prepare("SELECT * FROM hardware_test_runs WHERE id = ? AND device_id = ?").bind(runId, deviceId).first<Row>();
  return row ? mapRun(row, await loadSteps(db, runId)) : null;
}

export async function listHilRuns(db: DatabaseBinding, deviceId: string, limit = 10) {
  const result = await db.prepare(`SELECT * FROM hardware_test_runs WHERE device_id = ?
    ORDER BY started_at DESC LIMIT ?`).bind(deviceId, Math.max(1, Math.min(25, Math.round(limit)))).all<Row>();
  const runs: HilRunRecord[] = [];
  for (const row of result.results ?? []) runs.push(mapRun(row, await loadSteps(db, text(row.id))));
  return runs;
}

export async function createHilRun(db: DatabaseBinding, input: { deviceId: string; operator: string; targetCycles?: number }) {
  const device = await getDevice(db, input.deviceId);
  if (!device) throw new Error("Device not found");
  if (device.simulated || device.kind !== "PHYSICAL") throw new Error("Hardware-in-the-Loop requires a physical device");
  if (device.connectionState !== "ONLINE") throw new Error("Physical device must be online before starting Hardware-in-the-Loop");
  if (!device.agentVersion || !["0.5.", "0.6.", "0.7.", "0.8."].some((version) => device.agentVersion!.startsWith(version))) throw new Error("SWITCHBOARD Agent v0.5.x through v0.8.x is required");
  const active = await db.prepare(`SELECT id FROM hardware_test_runs WHERE device_id = ? AND status = 'RUNNING'`).bind(input.deviceId).first<Row>();
  if (active) throw new Error("A Hardware-in-the-Loop run is already active");
  const now = Date.now();
  const id = `HIL-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const targetCycles = Math.max(1000, Math.min(100_000, Math.round(input.targetCycles ?? 1000)));
  const statements: DatabaseStatement[] = [db.prepare(`INSERT INTO hardware_test_runs
    (id, device_id, status, agent_version, validated_configuration_version, validated_firmware_version, fixture, target_cycles, completed_cycles, failure_count, operator, notes, started_at)
    VALUES (?, ?, 'RUNNING', ?, ?, ?, 'D7 output to D2 input loopback', ?, 0, 0, ?, '', ?)
  `).bind(id, input.deviceId, device.agentVersion, device.configurationVersion, device.firmwareVersion,
    targetCycles, input.operator.trim().slice(0, 120) || "owner", now)];
  for (const stepKey of HIL_STEP_KEYS) statements.push(db.prepare(`INSERT INTO hardware_test_steps
    (run_id, step_key, status, observation, updated_at) VALUES (?, ?, 'PENDING', '', ?)
  `).bind(id, stepKey, now));
  await db.batch(statements);
  const run = await getHilRun(db, input.deviceId, id);
  if (!run) throw new Error("Hardware-in-the-Loop run was not created");
  return run;
}

async function recomputeRun(db: DatabaseBinding, deviceId: string, runId: string) {
  const run = await getHilRun(db, deviceId, runId);
  if (!run) throw new Error("Hardware-in-the-Loop run not found");
  if (run.status === "ABORTED") return run;
  const anyFailed = run.steps.some((step) => step.status === "FAILED") || run.failureCount > 0;
  const allPassed = run.steps.length === HIL_STEP_KEYS.length && run.steps.every((step) => step.status === "PASSED");
  const passed = allPassed && run.completedCycles >= run.targetCycles && run.failureCount === 0;
  if (passed) {
    const completedAt = Date.now();
    const accepted = await db.prepare(`UPDATE hardware_test_runs SET status = 'PASSED', completed_at = ?,
      validated_configuration_version = (SELECT configuration_version FROM devices WHERE id = ?)
      WHERE id = ? AND device_id = ? AND EXISTS (
        SELECT 1 FROM devices device WHERE device.id = ? AND device.connection_state = 'ONLINE' AND device.control_ready = 1
          AND device.agent_version = hardware_test_runs.agent_version
          AND COALESCE(device.firmware_version, '') = COALESCE(hardware_test_runs.validated_firmware_version, '')
      ) RETURNING id`).bind(completedAt, deviceId, runId, deviceId, deviceId).first<Row>();
    if (!accepted) throw new Error("Device identity, firmware, or synchronized connection changed during Hardware-in-the-Loop");
    return getHilRun(db, deviceId, runId);
  }
  const status: HilRunStatus = anyFailed ? "FAILED" : "RUNNING";
  await db.prepare("UPDATE hardware_test_runs SET status = ?, completed_at = NULL WHERE id = ? AND device_id = ?")
    .bind(status, runId, deviceId).run();
  return getHilRun(db, deviceId, runId);
}

export async function updateHilRun(db: DatabaseBinding, input: {
  deviceId: string; runId: string; stepKey?: unknown; stepStatus?: unknown;
  observation?: unknown; completedCycles?: unknown; failureCount?: unknown;
  notes?: unknown; abort?: boolean;
}) {
  const run = await getHilRun(db, input.deviceId, input.runId);
  if (!run) throw new Error("Hardware-in-the-Loop run not found");
  if (input.abort) {
    await db.prepare("UPDATE hardware_test_runs SET status = 'ABORTED', completed_at = ? WHERE id = ? AND device_id = ?")
      .bind(Date.now(), input.runId, input.deviceId).run();
    return getHilRun(db, input.deviceId, input.runId);
  }
  if (run.status === "ABORTED" || run.status === "PASSED") throw new Error(`Hardware-in-the-Loop run is ${run.status.toLowerCase()}`);
  const statements: DatabaseStatement[] = [];
  if (input.stepKey !== undefined || input.stepStatus !== undefined) {
    const stepKey = text(input.stepKey) as HilStepKey;
    const stepStatus = text(input.stepStatus) as HilStepStatus;
    if (!HIL_STEP_KEYS.includes(stepKey) || !["PENDING", "PASSED", "FAILED"].includes(stepStatus)) throw new Error("Invalid Hardware-in-the-Loop step update");
    statements.push(db.prepare(`UPDATE hardware_test_steps SET status = ?, observation = ?, updated_at = ?
      WHERE run_id = ? AND step_key = ?`).bind(stepStatus, text(input.observation).trim().slice(0, 240), Date.now(), input.runId, stepKey));
  }
  const completedCycles = typeof input.completedCycles === "number" ? Math.max(0, Math.min(100_000, Math.round(input.completedCycles))) : run.completedCycles;
  const failureCount = typeof input.failureCount === "number" ? Math.max(0, Math.min(completedCycles, Math.round(input.failureCount))) : run.failureCount;
  const notes = input.notes === undefined ? run.notes : text(input.notes).trim().slice(0, 1000);
  statements.push(db.prepare(`UPDATE hardware_test_runs SET completed_cycles = ?, failure_count = ?, notes = ?
    WHERE id = ? AND device_id = ?`).bind(completedCycles, failureCount, notes, input.runId, input.deviceId));
  await db.batch(statements);
  return recomputeRun(db, input.deviceId, input.runId);
}
