import { databaseError, getDatabase } from "@/db";
import { exchangeEnrollmentToken } from "@/lib/device-auth";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { token?: string };
    if (!payload.token) return Response.json({ error: "Enrollment token is required" }, { status: 400 });
    const hardwareId = `browser-transport-simulator-${crypto.randomUUID()}`;
    const result = await exchangeEnrollmentToken(getDatabase(), { token: payload.token, hardwareId, simulated: true });
    return Response.json(result, { status: 201 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 400 }); }
}
