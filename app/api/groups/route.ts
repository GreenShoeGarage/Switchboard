import { databaseError, getDatabase } from "@/db";
import { listGroups } from "@/lib/registry-server";

export async function GET() {
  try { return Response.json({ groups: await listGroups(getDatabase()) }); }
  catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { name?: string; description?: string };
    const name = payload.name?.trim().slice(0, 60) ?? "";
    if (!name) return Response.json({ error: "Group name is required" }, { status: 400 });
    const id = `GROUP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; const now = Date.now();
    const db = getDatabase();
    await db.prepare("INSERT INTO device_groups (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, payload.description?.trim().slice(0, 200) ?? "", now, now).run();
    return Response.json({ groups: await listGroups(db), id }, { status: 201 });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
