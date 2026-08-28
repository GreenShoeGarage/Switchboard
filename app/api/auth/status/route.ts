import { getDatabase } from "@/db";
import { installationIsConfigured, installationPublicBaseUrl } from "@/lib/operator-auth";

export const runtime = "nodejs";

export async function GET() {
  const configured = await installationIsConfigured(getDatabase());
  return Response.json(
    { configured, publicBaseUrl: configured ? await installationPublicBaseUrl(getDatabase()) : null },
    { headers: { "cache-control": "no-store" } },
  );
}
