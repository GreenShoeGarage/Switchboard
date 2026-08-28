import { databaseError, getDatabase } from "@/db";
import { createSimulator, listDevices } from "@/lib/registry-server";

export async function GET() {
  try { return Response.json({ devices: await listDevices(getDatabase()) }); }
  catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { action?: string; name?: string };
    if (payload.action !== "ensure-simulator" && payload.action !== "create-simulator") return Response.json({ error: "Unsupported device action" }, { status: 400 });
    const device = await createSimulator(getDatabase(), { ensure: payload.action === "ensure-simulator", name: payload.name });
    return Response.json({ device }, { status: 201 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
