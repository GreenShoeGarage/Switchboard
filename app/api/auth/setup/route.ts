import { getDatabase } from "@/db";
import { createInitialOwner, createOperatorSession, enforceOperatorAuthRateLimit, sessionCookie } from "@/lib/operator-auth";
import { authErrorResponse, readAuthPayload, requestIsSecure, stringField } from "@/lib/operator-auth-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let json = request.headers.get("content-type")?.startsWith("application/json") ?? false;
  try {
    const limitedFor = await enforceOperatorAuthRateLimit(getDatabase(), request, "setup");
    if (limitedFor) {
      return Response.json({ error: "Too many setup attempts" }, { status: 429, headers: { "retry-after": String(limitedFor) } });
    }
    const parsed = await readAuthPayload(request);
    json = parsed.json;
    const owner = await createInitialOwner(getDatabase(), {
      bootstrapToken: stringField(parsed.payload, "bootstrapToken"),
      configuredBootstrapToken: process.env.SWITCHBOARD_BOOTSTRAP_TOKEN,
      email: stringField(parsed.payload, "email"),
      password: stringField(parsed.payload, "password"),
      publicBaseUrl: stringField(parsed.payload, "publicBaseUrl"),
    });
    const token = await createOperatorSession(getDatabase(), owner.id);
    const headers = { "cache-control": "no-store", "set-cookie": sessionCookie(token, requestIsSecure(request)) };
    return json
      ? Response.json({ operator: owner }, { status: 201, headers })
      : new Response(null, { status: 303, headers: { ...headers, location: new URL("/", request.url).toString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed";
    return authErrorResponse(request, "/setup", message, /already configured/.test(message) ? 409 : 400, json);
  }
}
