import { getDatabase } from "@/db";
import { archiveAutomationRule, getAutomationRule, updateAutomationRule } from "@/lib/automation-server";
import { authenticatedActor, automationErrorResponse, automationPayloadError, isPositiveRevision, PRIVATE_NO_STORE } from "@/lib/automation-api";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params; const rule = await getAutomationRule(getDatabase(), id);
    return rule ? Response.json({ rule, automationTimezone: "UTC" }, { headers: PRIVATE_NO_STORE })
      : Response.json({ error: "Automation rule not found", code: "RULE_NOT_FOUND" }, { status: 404, headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const payload = await request.json() as Record<string, unknown>;
    const payloadError = automationPayloadError(payload, ["expectedRevision", "rule"]);
    if (payloadError) return payloadError;
    if (!isPositiveRevision(payload.expectedRevision) || !payload.rule) return Response.json({ error: "expectedRevision must be a positive safe integer and rule is required" }, { status: 400, headers: PRIVATE_NO_STORE });
    return Response.json({ rule: await updateAutomationRule(getDatabase(), id, payload.rule, payload.expectedRevision, authenticatedActor(request)) }, { headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const revisionValues = new URL(request.url).searchParams.getAll("expectedRevision");
    const rawRevision = revisionValues.length === 1 ? revisionValues[0] : null;
    const revision = rawRevision && /^[1-9]\d*$/.test(rawRevision) ? Number(rawRevision) : Number.NaN;
    if (!isPositiveRevision(revision)) return Response.json({ error: "expectedRevision must be a canonical positive safe integer" }, { status: 400, headers: PRIVATE_NO_STORE });
    await archiveAutomationRule(getDatabase(), id, revision, authenticatedActor(request));
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}
