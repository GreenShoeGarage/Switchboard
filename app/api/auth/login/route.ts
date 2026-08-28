import { safeRelativeReturnPath } from "@/app/operator-auth";
import { getDatabase } from "@/db";
import { authenticatePassword, createOperatorSession, enforceOperatorAuthRateLimit, installationIsConfigured, sessionCookie } from "@/lib/operator-auth";
import { authErrorResponse, readAuthPayload, requestIsSecure, stringField } from "@/lib/operator-auth-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let json = request.headers.get("content-type")?.startsWith("application/json") ?? false;
  try {
    if (!(await installationIsConfigured(getDatabase()))) {
      return authErrorResponse(request, "/setup", "Complete first-run setup before signing in", 409, json);
    }
    const limitedFor = await enforceOperatorAuthRateLimit(getDatabase(), request, "login");
    if (limitedFor) {
      return Response.json({ error: "Too many sign-in attempts" }, { status: 429, headers: { "retry-after": String(limitedFor) } });
    }
    const parsed = await readAuthPayload(request);
    json = parsed.json;
    const operator = await authenticatePassword(
      getDatabase(),
      stringField(parsed.payload, "email"),
      stringField(parsed.payload, "password"),
    );
    if (!operator) return authErrorResponse(request, "/login", "Email or password is incorrect", 401, json);
    const token = await createOperatorSession(getDatabase(), operator.id);
    const returnTo = safeRelativeReturnPath(
      typeof parsed.payload.returnTo === "string" ? parsed.payload.returnTo : new URL(request.url).searchParams.get("return_to"),
    );
    const headers = { "cache-control": "no-store", "set-cookie": sessionCookie(token, requestIsSecure(request)) };
    return json
      ? Response.json({ operator, returnTo }, { headers })
      : new Response(null, { status: 303, headers: { ...headers, location: new URL(returnTo, request.url).toString() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign-in failed";
    return authErrorResponse(request, "/login", message, 400, json);
  }
}
