import { getDatabase } from "@/db";
import { evaluateAutomationRule } from "@/lib/automation-server";
import { authenticatedActor, automationErrorResponse, automationPayloadError, isPositiveRevision, PRIVATE_NO_STORE } from "@/lib/automation-api";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const payload = await request.json() as Record<string, unknown>;
    const payloadError = automationPayloadError(payload, ["mode", "expectedRevision", "confirmHardware"]);
    if (payloadError) return payloadError;
    if (payload.mode !== "DRY_RUN" && payload.mode !== "MANUAL") return Response.json({ error: "mode must be DRY_RUN or MANUAL", code: "MODE_INVALID" }, { status: 400, headers: PRIVATE_NO_STORE });
    if (!isPositiveRevision(payload.expectedRevision)) return Response.json({ error: "expectedRevision must be a positive safe integer" }, { status: 400, headers: PRIVATE_NO_STORE });
    if (payload.confirmHardware !== undefined && typeof payload.confirmHardware !== "boolean") return Response.json({ error: "confirmHardware must be boolean" }, { status: 400, headers: PRIVATE_NO_STORE });
    const execution = await evaluateAutomationRule(getDatabase(), id, { mode: payload.mode, expectedRevision: payload.expectedRevision, confirmHardware: payload.confirmHardware as boolean | undefined, actor: authenticatedActor(request) });
    return Response.json({ execution, commandsSent: Boolean(execution?.actions.some((action) => action.gpioCommandId)) }, {
      status: execution?.status === "QUEUED" || execution?.status === "RUNNING" ? 202 : 200,
      headers: PRIVATE_NO_STORE,
    });
  } catch (error) { return automationErrorResponse(error); }
}
