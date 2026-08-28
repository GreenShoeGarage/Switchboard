import { getDatabase } from "@/db";
import { setAutomationRuleMode } from "@/lib/automation-server";
import { authenticatedActor, automationErrorResponse, automationPayloadError, isPositiveRevision, PRIVATE_NO_STORE } from "@/lib/automation-api";
import type { AutomationRuleMode } from "@/lib/device-model";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const payload = await request.json() as Record<string, unknown>;
    const payloadError = automationPayloadError(payload, ["mode", "expectedRevision"]);
    if (payloadError) return payloadError;
    if (!payload.mode || !isPositiveRevision(payload.expectedRevision)) return Response.json({ error: "mode and a positive safe-integer expectedRevision are required" }, { status: 400, headers: PRIVATE_NO_STORE });
    return Response.json(await setAutomationRuleMode(getDatabase(), id, payload.mode as AutomationRuleMode, payload.expectedRevision, authenticatedActor(request)), { headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}
