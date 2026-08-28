import { AutomationError } from "@/lib/automation-server";
import {
  authenticatedActor,
  databaseErrorResponse,
  firstUnknownField,
  invalidJsonResponse,
  isJsonObject,
  jsonError,
  PRIVATE_NO_STORE,
} from "@/lib/api-server";

export { authenticatedActor, PRIVATE_NO_STORE };

export function automationPayloadError(payload: unknown, allowed: readonly string[]) {
  if (!isJsonObject(payload)) {
    return jsonError("Request body must be an object", 400, { headers: PRIVATE_NO_STORE });
  }
  const unknown = firstUnknownField(payload, allowed);
  if (!unknown) return null;
  return jsonError(
    unknown === "actor" ? "Actor is derived from authenticated context" : `Unsupported wrapper field: ${unknown}`,
    400,
    { code: unknown === "actor" ? "ACTOR_SPOOF" : "UNKNOWN_FIELD", headers: PRIVATE_NO_STORE },
  );
}

export function automationErrorResponse(error: unknown) {
  if (error instanceof SyntaxError) return invalidJsonResponse(PRIVATE_NO_STORE);
  if (error instanceof AutomationError) {
    const headers = error.retryAfterMs
      ? { ...PRIVATE_NO_STORE, "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : PRIVATE_NO_STORE;
    return jsonError(error.message, error.status, {
      code: error.code,
      details: error.issues.length ? { issues: error.issues } : undefined,
      headers,
    });
  }
  return databaseErrorResponse(error, PRIVATE_NO_STORE);
}

export function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
