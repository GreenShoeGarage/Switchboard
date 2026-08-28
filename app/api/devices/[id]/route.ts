import { databaseError, getDatabase } from "@/db";
import { cancelQueuedAutomationForDevice } from "@/lib/automation-server";
import { getDevice } from "@/lib/registry-server";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params; const device = await getDevice(getDatabase(), id);
    return device ? Response.json({ device }) : Response.json({ error: "Device not found" }, { status: 404 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    const payload = await request.json() as { name?: string; groupId?: string | null; maintenanceMode?: boolean; monitorOnly?: boolean; automationArmed?: boolean };
    const current = await getDevice(db, id);
    if (!current) return Response.json({ error: "Device not found" }, { status: 404 });
    const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 80) : current.name;
    if (!name) return Response.json({ error: "Device name is required" }, { status: 400 });
    const groupId = payload.groupId === undefined ? current.groupId : payload.groupId;
    const maintenance = typeof payload.maintenanceMode === "boolean" ? payload.maintenanceMode : current.maintenanceMode;
    const monitorOnly = maintenance ? true : typeof payload.monitorOnly === "boolean" ? payload.monitorOnly : current.monitorOnly;
    const configurationChanged = name !== current.name || groupId !== current.groupId
      || maintenance !== current.maintenanceMode || monitorOnly !== current.monitorOnly;
    if (!current.simulated && configurationChanged && payload.automationArmed === true) {
      return Response.json({ error: "Save the physical configuration and complete a new Hardware-in-the-Loop run before arming automation" }, { status: 409 });
    }
    const requestedAutomationArmed = typeof payload.automationArmed === "boolean" ? payload.automationArmed : current.automationArmed;
    const automationArmed = !current.simulated && configurationChanged ? false : requestedAutomationArmed;
    if (automationArmed && !current.simulated) {
      const passed = await db.prepare(`SELECT run.id FROM hardware_test_runs run JOIN devices device ON device.id = run.device_id
        WHERE run.device_id = ? AND run.status = 'PASSED' AND run.agent_version = device.agent_version
          AND run.validated_configuration_version = device.configuration_version
          AND COALESCE(run.validated_firmware_version, '') = COALESCE(device.firmware_version, '')
          AND run.completed_cycles >= run.target_cycles AND run.failure_count = 0 ORDER BY run.completed_at DESC LIMIT 1`).bind(id).first<Record<string, unknown>>();
      if (!passed) return Response.json({ error: "Physical automation cannot be armed until Hardware-in-the-Loop passes" }, { status: 409 });
    }
    const activatingLock = (maintenance && !current.maintenanceMode) || (monitorOnly && !current.monitorOnly);
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE devices SET name = ?, group_id = ?, maintenance_mode = ?, monitor_only = ?, automation_armed = ?, configuration_version = configuration_version + ?, updated_at = ?
        WHERE id = ? AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM gpio_commands WHERE device_id = ? AND status = 'DELIVERED' AND deadline_at > ?
        ))`).bind(name, groupId, maintenance ? 1 : 0, monitorOnly ? 1 : 0, automationArmed ? 1 : 0, configurationChanged ? 1 : 0, now, id, activatingLock ? 1 : 0, id, now),
      db.prepare(`UPDATE gpio_commands SET status = 'FAILED', completed_at = ?, error = 'Device control lock enabled before delivery'
        WHERE device_id = ? AND status = 'QUEUED' AND origin <> 'AUTOMATION' AND ? = 1 AND EXISTS (
          SELECT 1 FROM devices WHERE id = ? AND maintenance_mode = ? AND monitor_only = ?
        )`).bind(now, id, activatingLock ? 1 : 0, id, maintenance ? 1 : 0, monitorOnly ? 1 : 0),
    ]);
    const next = await getDevice(db, id);
    if (activatingLock && (!next || next.maintenanceMode !== maintenance || next.monitorOnly !== monitorOnly)) {
      return Response.json({ error: "A delivered hardware command is still in flight; wait for its acknowledgment before enabling a control lock" }, { status: 409 });
    }
    if ((!automationArmed && current.automationArmed) || activatingLock) {
      await cancelQueuedAutomationForDevice(db, id, !automationArmed && current.automationArmed ? "Device automation permission disarmed" : "Device control lock enabled", undefined, now);
    }
    return Response.json({ device: next });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params; const db = getDatabase(); const current = await getDevice(db, id);
    if (!current) return Response.json({ error: "Device not found" }, { status: 404 });
    if (!current.simulated) return Response.json({ error: "Only simulated sample devices can be cleared here" }, { status: 403 });
    await db.prepare("DELETE FROM devices WHERE id = ? AND simulated = 1").bind(id).run();
    return new Response(null, { status: 204 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
