import { getDatabase } from "@/db";
import { databaseErrorResponse, invalidJsonResponse, isJsonObject, jsonError } from "@/lib/api-server";
import { cancelQueuedAutomationForDevice } from "@/lib/automation-server";
import { calibrationIssue, isPinMode, resolvePinConfiguration, safeStateIssue, type PinConfigurationInput } from "@/lib/pin-configuration";
import { getDevice, getDevicePins } from "@/lib/registry-server";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params; const db = getDatabase(); const device = await getDevice(db, id);
    if (!device) return jsonError("Device not found", 404);
    return Response.json({ schema: "switchboard.config.v4", exportedAt: new Date().toISOString(), device, pins: await getDevicePins(db, id), secretsIncluded: false });
  } catch (error) { return databaseErrorResponse(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params; const db = getDatabase(); const current = await getDevice(db, id);
    if (!current) return jsonError("Device not found", 404);
    const rawPayload = await request.json();
    if (!isJsonObject(rawPayload)) return jsonError("Request body must be an object", 400);
    const payload = rawPayload as { schema?: string; device?: unknown; pins?: unknown[] };
    if (!["switchboard.config.v2", "switchboard.config.v3", "switchboard.config.v4"].includes(payload.schema ?? "") || !Array.isArray(payload.pins)) return jsonError("Invalid SWITCHBOARD configuration schema", 400);
    const existingPins = await getDevicePins(db, id);
    const existingPinById = new Map(existingPins.map((pin) => [pin.pinId, pin]));
    const statements = [];
    const now = Date.now();
    for (const rawPin of payload.pins) {
      if (!isJsonObject(rawPin)) return jsonError("Invalid pin configuration: missing pin", 400);
      const pin = rawPin as PinConfigurationInput;
      const currentPin = typeof pin.pinId === "string" ? existingPinById.get(pin.pinId) : null;
      if (!pin.pinId || !currentPin || (pin.mode !== undefined && !isPinMode(pin.mode))) return jsonError(`Invalid pin configuration: ${pin.pinId ?? "missing pin"}`, 400);
      if (pin.mode && pin.mode !== currentPin.mode) {
        return jsonError(`Mode import for ${pin.pinId} requires an acknowledged device command`, 409);
      }
      const configuration = resolvePinConfiguration(currentPin, pin);
      const calibrationProblem = calibrationIssue(configuration);
      if (calibrationProblem === "INCOMPLETE") return jsonError(`Incomplete calibration for ${pin.pinId}`, 400);
      if (calibrationProblem === "DEGENERATE" || calibrationProblem === "UNIT_REQUIRED" || (calibrationProblem === "INPUT_OUT_OF_RANGE" && !configuration.engineeringUnit)) return jsonError(`Invalid calibration for ${pin.pinId}`, 400);
      if (calibrationProblem === "INPUT_OUT_OF_RANGE") return jsonError(`Calibration voltage out of range for ${pin.pinId}`, 400);
      const safeStateProblem = safeStateIssue(currentPin.mode, configuration.serverSafeValue);
      if (safeStateProblem === "DIGITAL_RANGE") return jsonError(`Invalid digital safe state for ${pin.pinId}`, 400);
      if (safeStateProblem === "ANALOG_RANGE") return jsonError(`Invalid 12-bit safe state for ${pin.pinId}`, 400);
      if (safeStateProblem === "NOT_OUTPUT") return jsonError(`Safe state requires an output mode for ${pin.pinId}`, 400);
      statements.push(db.prepare(`UPDATE device_pins SET label = ?, mode = ?, logical_low_label = ?, logical_high_label = ?,
        engineering_unit = ?, scale_input_low = ?, scale_output_low = ?, scale_input_high = ?, scale_output_high = ?, server_safe_value = ?, updated_at = ?
        WHERE device_id = ? AND pin_id = ?`).bind(configuration.label, configuration.mode, configuration.logicalLowLabel,
        configuration.logicalHighLabel, configuration.engineeringUnit, configuration.scaleInputLow, configuration.scaleOutputLow,
        configuration.scaleInputHigh, configuration.scaleOutputHigh, configuration.serverSafeValue, now, id, pin.pinId));
    }
    const deviceInput = isJsonObject(payload.device) ? payload.device : {};
    const name = typeof deviceInput.name === "string" ? deviceInput.name.trim().slice(0, 80) : current.name;
    if (!name) return jsonError("Device name is required", 400);
    statements.push(db.prepare("UPDATE devices SET name = ?, group_id = ?, configuration_version = configuration_version + 1, automation_armed = 0, updated_at = ? WHERE id = ?").bind(name, deviceInput.groupId === undefined ? current.groupId : deviceInput.groupId, now, id));
    await db.batch(statements);
    await cancelQueuedAutomationForDevice(db, id, "Device configuration changed");
    return Response.json({ device: await getDevice(db, id), pins: await getDevicePins(db, id) });
  } catch (error) { return error instanceof SyntaxError ? invalidJsonResponse() : databaseErrorResponse(error); }
}
