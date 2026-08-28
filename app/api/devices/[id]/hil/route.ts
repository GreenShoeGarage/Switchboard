import { databaseError, getDatabase } from "@/db";
import { authenticatedActor } from "@/lib/api-server";
import { createHilRun, getHilRun, listHilRuns, updateHilRun } from "@/lib/hil-server";

type Context = { params: Promise<{ id: string }> };

function statusForError(message: string) {
  if (message.includes("not found")) return 404;
  if (message.includes("already") || message.includes("online") || message.includes("physical") || message.includes("required")) return 409;
  return 400;
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    const runId = new URL(request.url).searchParams.get("runId");
    if (runId) {
      const run = await getHilRun(db, id, runId);
      return run ? Response.json({ run }) : Response.json({ error: "Hardware-in-the-Loop run not found" }, { status: 404 });
    }
    return Response.json({ runs: await listHilRuns(db, id) });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const payload = await request.json().catch(() => ({})) as { targetCycles?: number };
    return Response.json({ run: await createHilRun(getDatabase(), { deviceId: id, operator: authenticatedActor(request), targetCycles: payload.targetCycles }) }, { status: 201 });
  } catch (error) {
    const message = databaseError(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const payload = await request.json() as {
      runId?: string; stepKey?: string; stepStatus?: string; observation?: string;
      completedCycles?: number; failureCount?: number; notes?: string; abort?: boolean;
    };
    if (!payload.runId) return Response.json({ error: "runId is required" }, { status: 400 });
    const runId = payload.runId;
    const run = await updateHilRun(getDatabase(), { deviceId: id, ...payload, runId });
    return Response.json({ run });
  } catch (error) {
    const message = databaseError(error);
    return Response.json({ error: message }, { status: statusForError(message) });
  }
}
