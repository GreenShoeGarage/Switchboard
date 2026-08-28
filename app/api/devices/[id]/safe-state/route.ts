import { databaseError, getDatabase } from "@/db";
import { authenticatedActor, jsonError } from "@/lib/api-server";
import { executeServerSimulatorCommand } from "@/lib/gpio-server";
import { getDevice } from "@/lib/registry-server";
import { createSafeStateRun, listSafeStateCommands, listSafeStateRuns, refreshSafeStateRun } from "@/lib/safety-server";

type Context = { params: Promise<{ id: string }> };

function statusForError(message: string) {
  if (message.includes("not found")) return 404;
  if (["DEVICE_OFFLINE", "DEVICE_NOT_SYNCHRONIZED", "DEVICE_IN_MAINTENANCE", "DEVICE_MONITOR_ONLY", "PIN_COMMAND_PENDING", "SAFE_STATE_NOT_CONFIGURED", "SAFE_STATE_QUEUE_FAILED"].includes(message)) return 409;
  return 400;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    if (!await getDevice(db, id)) return jsonError("Device not found", 404);
    return Response.json({ runs: await listSafeStateRuns(db, id) });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    let result = await createSafeStateRun(db, { deviceId: id, actor: authenticatedActor(request) });
    const device = await getDevice(db, id);
    if (device?.simulated) {
      for (const command of result.commands) await executeServerSimulatorCommand(db, id, command.id);
      result = { run: (await refreshSafeStateRun(db, id, result.run.id))!, commands: await listSafeStateCommands(db, id, result.run.id) };
    }
    return Response.json(result, { status: result.run.status === "ACKNOWLEDGED" ? 200 : 202 });
  } catch (error) {
    const message = databaseError(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  }
}
