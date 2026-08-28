import { safeRelativeReturnPath } from "@/app/operator-auth";

export const MAX_AUTH_BODY_BYTES = 8_192;

export async function readAuthPayload(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_AUTH_BODY_BYTES)) {
    throw new Error("Request body is too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_AUTH_BODY_BYTES) throw new Error("Request body is too large");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
    return { payload: parsed as Record<string, unknown>, json: true };
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return { payload: Object.fromEntries(new URLSearchParams(body)), json: false };
  }
  throw new Error("Content-Type must be application/json or application/x-www-form-urlencoded");
}

export function authErrorResponse(request: Request, path: string, message: string, status: number, json: boolean) {
  if (json) return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
  const location = new URL(path, request.url);
  location.searchParams.set("error", message.slice(0, 180));
  const returnTo = safeRelativeReturnPath(new URL(request.url).searchParams.get("return_to"));
  if (path === "/login" && returnTo !== "/") location.searchParams.set("return_to", returnTo);
  return Response.redirect(location, 303);
}

export function requestIsSecure(request: Request) {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  return forwardedProtocol === "https" || new URL(request.url).protocol === "https:";
}

export function stringField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}
