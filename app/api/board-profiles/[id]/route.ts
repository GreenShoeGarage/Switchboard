import { getBoardProfile } from "@/lib/board-profiles";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params; const profile = getBoardProfile(id);
  return profile ? Response.json({ profile }) : Response.json({ error: "Board profile not found" }, { status: 404 });
}
