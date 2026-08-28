import { databaseError, getDatabase } from "@/db";
import { authenticatedActor, invalidJsonResponse, isJsonObject, jsonError } from "@/lib/api-server";
import { continueAutomationFromCommand } from "@/lib/automation-server";
import {
  executeServerSimulatorCommand,
  getGpioCommand,
  issueGpioCommand,
  listGpioCommands,
} from "@/lib/gpio-server";
import { getDevice, getDevicePins } from "@/lib/registry-server";
import type { GpioCommandKind, PinMode } from "@/lib/device-model";

type Context = { params: Promise<{ id: string }> };

function statusForError(message: string) {
  if (message === "Device not found" || message.includes("not found")) return 404;
  if (["DEVICE_OFFLINE", "DEVICE_NOT_SYNCHRONIZED", "DEVICE_IN_MAINTENANCE", "DEVICE_MONITOR_ONLY", "PIN_COMMAND_PENDING"].includes(message) || message.includes("not configured")) return 409;
  return 400;
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    const commandId = new URL(request.url).searchParams.get("commandId");
    if (commandId) {
      const command = await getGpioCommand(db, id, commandId);
      return command
        ? Response.json({ command, pins: await getDevicePins(db, id) })
        : jsonError("GPIO command not found", 404);
    }
    return Response.json({ commands: await listGpioCommands(db, id), pins: await getDevicePins(db, id) });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const rawPayload = await request.json();
    if (!isJsonObject(rawPayload)) return jsonError("Request body must be an object", 400);
    const payload = rawPayload as { kind?: GpioCommandKind; pinId?: string; requestedMode?: PinMode; requestedValue?: number };
    if (!payload.kind || !payload.pinId) return jsonError("kind and pinId are required", 400);
    const db = getDatabase();
    let command = await issueGpioCommand(db, {
      deviceId: id, pinId: payload.pinId, kind: payload.kind,
      requestedMode: payload.requestedMode, requestedValue: payload.requestedValue, actor: authenticatedActor(request),
    });
    const device = await getDevice(db, id);
    if (device?.simulated) {
      command = (await executeServerSimulatorCommand(db, id, command.id)) ?? command;
      if (command.status === "ACKNOWLEDGED") await continueAutomationFromCommand(db, command.id);
    }
    return Response.json({ command, pins: await getDevicePins(db, id), commands: await listGpioCommands(db, id) }, { status: command.status === "ACKNOWLEDGED" ? 200 : 202 });
  } catch (error) {
    if (error instanceof SyntaxError) return invalidJsonResponse();
    const message = databaseError(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  }
}
