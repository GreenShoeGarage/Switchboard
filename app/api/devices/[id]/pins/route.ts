import { getDatabase } from "@/db";
import { databaseErrorResponse, invalidJsonResponse, isJsonObject, jsonError } from "@/lib/api-server";
import { cancelQueuedAutomationForDevice } from "@/lib/automation-server";
import { calibrationIssue, calibrationWasRequested, isPinMode, resolvePinConfiguration, safeStateIssue, type PinConfigurationInput } from "@/lib/pin-configuration";
import { getDevice, getDevicePins } from "@/lib/registry-server";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try { const { id } = await context.params; return Response.json({ pins: await getDevicePins(getDatabase(), id) }); }
  catch (error) { return databaseErrorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const rawPayload = await request.json();
    if (!isJsonObject(rawPayload)) return jsonError("Request body must be an object", 400);
    const payload = rawPayload as PinConfigurationInput;
    if (!payload.pinId) return jsonError("pinId is required", 400);
    const db = getDatabase();
    const device = await getDevice(db, id);
    if (!device) return jsonError("Device not found", 404);
    const pins = await getDevicePins(db, id); const current = pins.find((pin) => pin.pinId === payload.pinId);
    if (!current) return jsonError("Pin not found in device profile", 404);
    if (payload.mode !== undefined && !isPinMode(payload.mode)) return jsonError("Invalid pin mode", 400);
    if (calibrationWasRequested(payload) && !current.capability.includes("ANALOG")) return jsonError("Calibration requires an analog-input pin", 400);
    if (payload.mode && payload.mode !== current.mode) {
      return jsonError("Pin mode changes require an acknowledged device command", 409);
    }
    const configuration = resolvePinConfiguration(current, payload);
    const calibrationProblem = calibrationIssue(configuration);
    if (calibrationProblem === "INCOMPLETE") return jsonError("Calibration requires all four finite points or all four cleared", 400);
    if (calibrationProblem === "DEGENERATE") return jsonError("Calibration input and output points must differ", 400);
    if (calibrationProblem === "INPUT_OUT_OF_RANGE") return jsonError("Calibration input voltage must be between 0 and 5 V", 400);
    if (calibrationProblem === "UNIT_REQUIRED") return jsonError("Engineering unit is required for calibrated values", 400);
    const safeStateProblem = safeStateIssue(current.mode, configuration.serverSafeValue);
    if (safeStateProblem === "DIGITAL_RANGE") return jsonError("Digital safe-state value must be 0 or 1", 400);
    if (safeStateProblem === "ANALOG_RANGE") return jsonError("PWM and DAC safe-state values must be 12-bit integers", 400);
    if (safeStateProblem === "NOT_OUTPUT") return jsonError("Safe-state values require a currently configured output pin", 400);
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE device_pins SET label = ?, mode = ?, logical_low_label = ?, logical_high_label = ?,
        engineering_unit = ?, scale_input_low = ?, scale_output_low = ?, scale_input_high = ?, scale_output_high = ?, server_safe_value = ?, updated_at = ?
        WHERE device_id = ? AND pin_id = ?`).bind(configuration.label, configuration.mode, configuration.logicalLowLabel, configuration.logicalHighLabel,
        configuration.engineeringUnit, configuration.scaleInputLow, configuration.scaleOutputLow, configuration.scaleInputHigh,
        configuration.scaleOutputHigh, configuration.serverSafeValue, now, id, payload.pinId),
      db.prepare("UPDATE devices SET configuration_version = configuration_version + 1, automation_armed = 0, updated_at = ? WHERE id = ?").bind(now, id),
    ]);
    await cancelQueuedAutomationForDevice(db, id, "Device configuration changed");
    return Response.json({ pins: await getDevicePins(db, id), device: await getDevice(db, id) });
  } catch (error) { return error instanceof SyntaxError ? invalidJsonResponse() : databaseErrorResponse(error); }
}
