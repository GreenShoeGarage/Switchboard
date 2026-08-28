import { getDatabase } from "@/db";
import { listAutomationExecutions } from "@/lib/automation-server";
import { automationErrorResponse, PRIVATE_NO_STORE } from "@/lib/automation-api";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const limitValue = query.get("limit");
    const executions = await listAutomationExecutions(getDatabase(), {
      ruleId: query.get("ruleId"), status: query.get("status"), sourceKind: query.get("source"),
      limit: limitValue === null ? 100 : Number(limitValue),
    });
    return Response.json({ executions }, { headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}
