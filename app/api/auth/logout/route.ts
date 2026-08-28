import { getDatabase } from "@/db";
import { clearSessionCookie, parseCookies, revokeOperatorSession, SESSION_COOKIE_NAME } from "@/lib/operator-auth";
import { requestIsSecure } from "@/lib/operator-auth-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = parseCookies(request.headers.get("cookie") ?? undefined).get(SESSION_COOKIE_NAME) ?? null;
  await revokeOperatorSession(getDatabase(), token);
  const headers = { "cache-control": "no-store", "set-cookie": clearSessionCookie(requestIsSecure(request)) };
  if (request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ signedOut: true }, { headers });
  return new Response(null, { status: 303, headers: { ...headers, location: new URL("/login", request.url).toString() } });
}
