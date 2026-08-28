import { databaseError, getDatabase } from "@/db";
import { revokeCredential } from "@/lib/device-auth";

type Context = { params: Promise<{ id: string; credentialId: string }> };
export async function DELETE(_request: Request, context: Context) {
  try {
    const { id, credentialId } = await context.params;
    return Response.json({ credentials: await revokeCredential(getDatabase(), id, credentialId) });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
