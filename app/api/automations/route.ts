import { getDatabase } from "@/db";
import { createAutomationRule, listAutomationExecutions, listAutomationRules } from "@/lib/automation-server";
import { authenticatedActor, automationErrorResponse, PRIVATE_NO_STORE } from "@/lib/automation-api";

export async function GET() {
  try {
    const [rules, executions] = await Promise.all([listAutomationRules(getDatabase()), listAutomationExecutions(getDatabase(), { limit: 40 })]);
    return Response.json({ rules, executions, automationTimezone: "UTC", timingModel: "DEVICE_ACTIVITY_DRIVEN" }, { headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const rule = await createAutomationRule(getDatabase(), payload, authenticatedActor(request));
    return Response.json({ rule, automationTimezone: "UTC" }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}
