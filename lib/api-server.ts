import { databaseError } from "@/db";
import { OPERATOR_EMAIL_HEADER } from "@/lib/operator-auth";

export const PRIVATE_NO_STORE = { "cache-control": "private, no-store" } as const;

type ErrorDetails = Record<string, unknown>;

export function authenticatedActor(request: Request) {
  return request.headers.get(OPERATOR_EMAIL_HEADER)?.trim().slice(0, 120) || "owner";
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function firstUnknownField(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).find((key) => !allowed.includes(key)) ?? null;
}

export function jsonError(
  message: string,
  status: number,
  options: { code?: string; details?: ErrorDetails; headers?: HeadersInit } = {},
) {
  return Response.json(
    { error: message, ...(options.code ? { code: options.code } : {}), ...options.details },
    { status, headers: options.headers },
  );
}

export function invalidJsonResponse(headers?: HeadersInit) {
  return jsonError("Request body must be valid JSON", 400, { code: "INVALID_JSON", headers });
}

export function databaseErrorResponse(error: unknown, headers?: HeadersInit) {
  return jsonError(databaseError(error), 500, { headers });
}
