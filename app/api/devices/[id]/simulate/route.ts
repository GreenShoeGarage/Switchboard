import { databaseError, getDatabase } from "@/db";
import { continueAutomationFromCommand, evaluateAutomationForDevice, resetAutomationForSourceDevice, runDueAutomationCycle } from "@/lib/automation-server";
import { getDevice, getDevicePins, setConnectionState } from "@/lib/registry-server";
import { executeServerSimulatorCommand, issueGpioCommand, listGpioCommands } from "@/lib/gpio-server";
import { isDeviceState } from "@/lib/device-model";
import { rawFromEngineering, scaleAnalogRaw, telemetryStatements } from "@/lib/telemetry-server";
import { authenticatedActor } from "@/lib/api-server";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params; const db = getDatabase();
    const device = await getDevice(db, id);
    if (!device) return Response.json({ error: "Device not found" }, { status: 404 });
    if (!device.simulated) return Response.json({ error: "Simulator controls require a simulated device" }, { status: 403 });
    const payload = await request.json() as { action?: string; state?: unknown; pinId?: string; value?: number };

    if (payload.action === "set-state") {
      if (!isDeviceState(payload.state)) return Response.json({ error: "Invalid connection state" }, { status: 400 });
      const updated = await setConnectionState(db, id, payload.state, `Simulator entered ${payload.state.toLowerCase()}`);
      if (payload.state !== "ONLINE") await resetAutomationForSourceDevice(db, id);
      return Response.json({ device: updated });
    }

    if (payload.action === "tick") {
      if (device.connectionState !== "ONLINE") return Response.json({ device, pins: await getDevicePins(db, id) });
      const now = Date.now(); const pressure = Number((40.5 + Math.random() * 2.7).toFixed(1)); const temperature = Number((23.8 + Math.random() * 1.2).toFixed(1));
      const pins = await getDevicePins(db, id);
      const a0 = pins.find((pin) => pin.pinId === "A0")!; const a1 = pins.find((pin) => pin.pinId === "A1")!;
      const rawPressure = rawFromEngineering(device.boardProfileId, a0, pressure);
      const rawTemperature = rawFromEngineering(device.boardProfileId, a1, temperature);
      const scaledPressure = scaleAnalogRaw(device.boardProfileId, a0, rawPressure);
      const scaledTemperature = scaleAnalogRaw(device.boardProfileId, a1, rawTemperature);
      await db.batch([
        db.prepare("UPDATE device_pins SET confirmed_value = ?, confirmed_raw_value = ?, sampled_at = ?, updated_at = ? WHERE device_id = ? AND pin_id = 'A0'").bind(scaledPressure.engineeringValue, rawPressure, now, now, id),
        db.prepare("UPDATE device_pins SET confirmed_value = ?, confirmed_raw_value = ?, sampled_at = ?, updated_at = ? WHERE device_id = ? AND pin_id = 'A1'").bind(scaledTemperature.engineeringValue, rawTemperature, now, now, id),
        db.prepare("UPDATE devices SET last_seen_at = ?, rssi_dbm = ?, updated_at = ? WHERE id = ?").bind(now, -54 - Math.floor(Math.random() * 4), now, id),
        ...telemetryStatements(db, { deviceId: id, pinId: "A0", rawValue: rawPressure, voltageValue: scaledPressure.voltageValue, engineeringValue: scaledPressure.engineeringValue, engineeringUnit: scaledPressure.engineeringUnit, recordedAt: now }),
        ...telemetryStatements(db, { deviceId: id, pinId: "A1", rawValue: rawTemperature, voltageValue: scaledTemperature.voltageValue, engineeringValue: scaledTemperature.engineeringValue, engineeringUnit: scaledTemperature.engineeringUnit, recordedAt: now }),
      ]);
      await evaluateAutomationForDevice(db, id, now);
      await runDueAutomationCycle(db, now);
      return Response.json({ device: await getDevice(db, id), pins: await getDevicePins(db, id) });
    }

    if (payload.action === "command") {
      if (device.connectionState !== "ONLINE") return Response.json({ error: "DEVICE_OFFLINE" }, { status: 409 });
      if (device.maintenanceMode) return Response.json({ error: "DEVICE_IN_MAINTENANCE" }, { status: 409 });
      if (!payload.pinId || typeof payload.value !== "number") return Response.json({ error: "pinId and value are required" }, { status: 400 });
      const pins = await getDevicePins(db, id); const pin = pins.find((item) => item.pinId === payload.pinId);
      if (!pin || !["OUTPUT", "PWM", "DAC"].includes(pin.mode)) return Response.json({ error: "Pin is not configured as an output" }, { status: 409 });
      const issued = await issueGpioCommand(db, {
        deviceId: id, pinId: payload.pinId, kind: pin.mode === "PWM" ? "WRITE_PWM" : pin.mode === "DAC" ? "WRITE_DAC" : "WRITE", requestedValue: payload.value,
        actor: authenticatedActor(request),
      });
      const command = await executeServerSimulatorCommand(db, id, issued.id);
      if (command?.status === "ACKNOWLEDGED") await continueAutomationFromCommand(db, issued.id);
      return Response.json({
        acknowledgment: { commandId: command?.id, pinId: payload.pinId, confirmedValue: command?.confirmedValue, latencyMs: command?.latencyMs ?? 0 },
        command, commands: await listGpioCommands(db, id), pins: await getDevicePins(db, id),
      });
    }

    return Response.json({ error: "Unsupported simulator action" }, { status: 400 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
