import type { DatabaseBinding, DatabaseStatement } from "@/db";
import { TRUSTED_CLIENT_ADDRESS_HEADER } from "@/lib/operator-auth";

export const DEVICE_ENROLLMENT_PATH = "/api/device-enrollment/exchange";
export const DEVICE_SOCKET_PATH = "/api/device/socket";
export const MAX_ENROLLMENT_BODY_BYTES = 2_048;

export type DeviceGatewayRequestKind = "enrollment" | "socket";

type RateLimitPolicy = {
  clientLimit: number;
  globalLimit: number;
  windowMs: number;
};

const RATE_LIMITS: Record<DeviceGatewayRequestKind, RateLimitPolicy> = {
  enrollment: { clientLimit: 12, globalLimit: 600, windowMs: 60_000 },
  socket: { clientLimit: 30, globalLimit: 1_200, windowMs: 60_000 },
};

const PUBLIC_NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

export function isFrameworkStaticAsset(pathname: string) {
  return pathname.startsWith("/_next/static/") || pathname.startsWith("/_next/webpack-hmr");
}

export function isCommunityAuthPath(pathname: string) {
  return pathname === "/login" || pathname === "/setup" || pathname.startsWith("/api/auth/");
}

export function deviceGatewayKind(pathname: string): DeviceGatewayRequestKind | null {
  if (pathname === DEVICE_ENROLLMENT_PATH) return "enrollment";
  if (pathname === DEVICE_SOCKET_PATH) return "socket";
  return null;
}

export function deviceGatewayMethodResponse(request: Request, kind: DeviceGatewayRequestKind) {
  const allowedMethod = kind === "enrollment" ? "POST" : "GET";
  if (request.method === allowedMethod) return null;
  return Response.json(
    { error: `Method ${request.method} is not allowed` },
    { status: 405, headers: { ...PUBLIC_NO_STORE, allow: allowedMethod } },
  );
}

async function readBoundedBody(request: Request, maximumBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel("Request body exceeded the gateway limit");
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readEnrollmentRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return {
      response: Response.json(
        { error: "Content-Type must be application/json", code: "UNSUPPORTED_MEDIA_TYPE" },
        { status: 415, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ENROLLMENT_BODY_BYTES)) {
    return {
      response: Response.json(
        { error: "Enrollment request is too large", code: "PAYLOAD_TOO_LARGE" },
        { status: 413, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  const bytes = await readBoundedBody(request, MAX_ENROLLMENT_BODY_BYTES);
  if (!bytes) {
    return {
      response: Response.json(
        { error: "Enrollment request is too large", code: "PAYLOAD_TOO_LARGE" },
        { status: 413, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      response: Response.json(
        { error: "Request body must be valid JSON", code: "INVALID_JSON" },
        { status: 400, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      response: Response.json(
        { error: "Request body must be a JSON object", code: "INVALID_REQUEST" },
        { status: 400, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  const payload = value as Record<string, unknown>;
  const unknownField = Object.keys(payload).find((key) => key !== "token" && key !== "hardwareId");
  if (unknownField) {
    return {
      response: Response.json(
        { error: `Unknown field: ${unknownField}`, code: "UNKNOWN_FIELD" },
        { status: 400, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }
  if (typeof payload.token !== "string" || typeof payload.hardwareId !== "string") {
    return {
      response: Response.json(
        { error: "token and hardwareId are required", code: "INVALID_REQUEST" },
        { status: 400, headers: PUBLIC_NO_STORE },
      ),
    } as const;
  }

  return { payload: { token: payload.token, hardwareId: payload.hardwareId } } as const;
}

function rateLimitUpsert(db: DatabaseBinding, bucketKey: string, windowStartedAt: number, now: number): DatabaseStatement {
  return db.prepare(`
    INSERT INTO device_gateway_rate_limits (bucket_key, window_started_at, request_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      request_count = CASE
        WHEN device_gateway_rate_limits.window_started_at = excluded.window_started_at
          THEN device_gateway_rate_limits.request_count + 1
        ELSE 1
      END,
      updated_at = excluded.updated_at
  `).bind(bucketKey, windowStartedAt, now);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trustedClientAddress(request: Request) {
  return request.headers.get(TRUSTED_CLIENT_ADDRESS_HEADER)?.trim().slice(0, 128) || "address-unavailable";
}

export async function enforceDeviceGatewayRateLimit(
  db: DatabaseBinding,
  request: Request,
  kind: DeviceGatewayRequestKind,
  now = Date.now(),
) {
  const policy = RATE_LIMITS[kind];
  const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
  const clientHash = await sha256Hex(trustedClientAddress(request));
  const clientBucket = `${kind}:client:${clientHash}`;
  const globalBucket = `${kind}:global`;

  await db.batch([
    rateLimitUpsert(db, clientBucket, windowStartedAt, now),
    rateLimitUpsert(db, globalBucket, windowStartedAt, now),
  ]);

  const client = await db.prepare(
    "SELECT request_count FROM device_gateway_rate_limits WHERE bucket_key = ? AND window_started_at = ?",
  ).bind(clientBucket, windowStartedAt).first<{ request_count: number }>();
  const global = await db.prepare(
    "SELECT request_count FROM device_gateway_rate_limits WHERE bucket_key = ? AND window_started_at = ?",
  ).bind(globalBucket, windowStartedAt).first<{ request_count: number }>();
  const clientCount = Number(client?.request_count ?? 0);
  const globalCount = Number(global?.request_count ?? 0);
  const limited = clientCount > policy.clientLimit || globalCount > policy.globalLimit;
  if (!limited) return null;

  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartedAt + policy.windowMs - now) / 1_000));
  return Response.json(
    { error: "Device gateway rate limit exceeded", code: "RATE_LIMITED" },
    {
      status: 429,
      headers: {
        ...PUBLIC_NO_STORE,
        "retry-after": String(retryAfterSeconds),
        "x-ratelimit-limit": String(policy.clientLimit),
        "x-ratelimit-remaining": "0",
      },
    },
  );
}

export async function pruneDeviceGatewayRateLimits(db: DatabaseBinding, before: number) {
  await db.prepare("DELETE FROM device_gateway_rate_limits WHERE updated_at < ?").bind(before).run();
}
