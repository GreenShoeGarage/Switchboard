import { listBoardProfiles } from "@/lib/board-profiles";
export async function GET() { return Response.json({ profiles: listBoardProfiles() }); }
