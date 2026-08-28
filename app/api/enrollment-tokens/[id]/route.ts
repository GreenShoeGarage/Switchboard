import { databaseError, getDatabase } from "@/db";
import { revokeEnrollmentToken } from "@/lib/device-auth";

type Context = { params: Promise<{ id: string }> };
export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const token = await revokeEnrollmentToken(getDatabase(), id);
    return token ? Response.json({ token }) : Response.json({ error: "Enrollment token not found" }, { status: 404 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
