import { databaseError, getDatabase } from "@/db";
import { createEnrollmentToken, listEnrollmentTokens } from "@/lib/device-auth";

export async function GET() {
  try { return Response.json({ tokens: await listEnrollmentTokens(getDatabase()), serverTime: Date.now() }); }
  catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { boardProfileId?: string; deviceName?: string; ttlMinutes?: number };
    const result = await createEnrollmentToken(getDatabase(), {
      boardProfileId: payload.boardProfileId ?? "arduino-uno-r4-wifi",
      deviceName: payload.deviceName ?? "",
      ttlMinutes: payload.ttlMinutes,
    });
    return Response.json(result, { status: 201 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 400 }); }
}
