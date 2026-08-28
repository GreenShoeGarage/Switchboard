import { databaseError, getDatabase } from "@/db";
import { getTransportBundle } from "@/lib/device-auth";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const bundle = await getTransportBundle(getDatabase(), id);
    return bundle ? Response.json(bundle) : Response.json({ error: "Device not found" }, { status: 404 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
