import { databaseError, getDatabase } from "@/db";
import { listConnectionEvents } from "@/lib/registry-server";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { const { id } = await context.params; return Response.json({ events: await listConnectionEvents(getDatabase(), id) }); }
  catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
