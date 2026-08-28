import { getDatabase } from "@/db";
import { automationErrorResponse, PRIVATE_NO_STORE } from "@/lib/automation-api";
import { validateAutomationDraft } from "@/lib/automation-server";

export async function POST(request: Request) {
  try {
    const validation = await validateAutomationDraft(getDatabase(), await request.json());
    return Response.json({ ...validation, automationTimezone: "UTC" }, { status: validation.valid ? 200 : 422, headers: PRIVATE_NO_STORE });
  } catch (error) { return automationErrorResponse(error); }
}
