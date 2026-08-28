import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

import type { DatabaseBinding, DatabaseStatement } from "@/db";

export const OPERATOR_EMAIL_HEADER = "x-switchboard-authenticated-user-email";
export const OPERATOR_ROLE_HEADER = "x-switchboard-authenticated-user-role";
export const TRUSTED_CLIENT_ADDRESS_HEADER = "x-switchboard-client-address";
export const SESSION_COOKIE_NAME = "switchboard_session";

const INSTALLATION_ID = "default";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const PASSWORD_MINIMUM_LENGTH = 12;
const PASSWORD_MAXIMUM_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(SCRYPT_KEY_LENGTH).toString("base64url")}`;

export type OperatorRole = "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER";

export type OperatorIdentity = {
  id: string;
  email: string;
  role: OperatorRole;
};

type OperatorUserRow = OperatorIdentity & {
  password_hash: string;
};

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address");
  }
  return email;
}

function validatePassword(password: string) {
  if (password.length < PASSWORD_MINIMUM_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAXIMUM_LENGTH) {
    throw new Error(`Password must be no more than ${PASSWORD_MAXIMUM_LENGTH} characters`);
  }
}

function normalizePublicBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Public URL must be a valid http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Public URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Public URL cannot include credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") throw new Error("Public URL must use a dedicated hostname without a path");
  return url.origin;
}

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

async function passwordMatches(password: string, encoded: string) {
  const [algorithm, saltValue, keyValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !keyValue || password.length > PASSWORD_MAXIMUM_LENGTH) return false;
  try {
    const expected = Buffer.from(keyValue, "base64url");
    const actual = await scrypt(password, Buffer.from(saltValue, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function installationIsConfigured(db: DatabaseBinding) {
  const row = await db.prepare("SELECT id FROM installation_settings WHERE id = ?").bind(INSTALLATION_ID).first<{ id: string }>();
  return Boolean(row);
}

export async function installationPublicBaseUrl(db: DatabaseBinding) {
  const row = await db.prepare("SELECT public_base_url FROM installation_settings WHERE id = ?")
    .bind(INSTALLATION_ID)
    .first<{ public_base_url: string }>();
  return row?.public_base_url ?? null;
}

function secretsMatch(supplied: string, expected: string) {
  return timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(expected).digest());
}

export async function createInitialOwner(
  db: DatabaseBinding,
  input: { bootstrapToken: string; configuredBootstrapToken: string | undefined; email: string; password: string; publicBaseUrl: string },
) {
  const configuredToken = input.configuredBootstrapToken?.trim() ?? "";
  if (configuredToken.length < 24) throw new Error("Server bootstrap token is not configured");
  if (!secretsMatch(input.bootstrapToken, configuredToken)) throw new Error("Bootstrap token is invalid");
  if (await installationIsConfigured(db)) throw new Error("SWITCHBOARD is already configured");

  const email = normalizeEmail(input.email);
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl);
  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const userId = randomUUID();

  await db.batch([
    db.prepare(`INSERT INTO operator_users (id, email, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, 'OWNER', ?, ?)`).bind(userId, email, passwordHash, now, now),
    db.prepare(`INSERT INTO installation_settings (id, public_base_url, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).bind(INSTALLATION_ID, publicBaseUrl, now, now),
  ]);

  return { id: userId, email, role: "OWNER" as const };
}

export async function authenticatePassword(db: DatabaseBinding, emailValue: string, password: string) {
  let email: string;
  try { email = normalizeEmail(emailValue); }
  catch { return null; }

  const user = await db.prepare(`SELECT id, email, password_hash, role FROM operator_users
    WHERE email = ? AND disabled_at IS NULL`).bind(email).first<OperatorUserRow>();
  const matches = await passwordMatches(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !matches) return null;
  return { id: user.id, email: user.email, role: user.role } satisfies OperatorIdentity;
}

export async function createOperatorSession(db: DatabaseBinding, userId: string) {
  const token = `swsess_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await db.prepare("DELETE FROM operator_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
    .bind(now, now - SESSION_DURATION_MS).run();
  await db.prepare(`INSERT INTO operator_sessions
    (id, user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(randomUUID(), userId, sha256Hex(token), now, now + SESSION_DURATION_MS, now).run();
  return token;
}

export async function authenticateOperatorSession(db: DatabaseBinding, token: string | null, now = Date.now()) {
  if (!token || token.length > 128) return null;
  const session = await db.prepare(`SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.role
    FROM operator_sessions s
    JOIN operator_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`)
    .bind(sha256Hex(token), now)
    .first<OperatorIdentity & { session_id: string; last_seen_at: number }>();
  if (!session) return null;
  if (now - Number(session.last_seen_at) > 5 * 60 * 1_000) {
    await db.prepare("UPDATE operator_sessions SET last_seen_at = ? WHERE id = ?").bind(now, session.session_id).run();
  }
  return { id: session.id, email: session.email, role: session.role } satisfies OperatorIdentity;
}

export async function revokeOperatorSession(db: DatabaseBinding, token: string | null) {
  if (!token || token.length > 128) return;
  await db.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(Date.now(), sha256Hex(token)).run();
}

export function parseCookies(headerValue: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of (headerValue ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies.set(name, decodeURIComponent(value)); }
    catch { /* Ignore malformed cookie values. */ }
  }
  return cookies;
}

export function sessionCookie(token: string, secure: boolean) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION_MS / 1_000}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

type AuthRateLimitKind = "login" | "setup";
const AUTH_RATE_LIMITS: Record<AuthRateLimitKind, number> = { login: 10, setup: 5 };

function rateLimitUpsert(db: DatabaseBinding, bucketKey: string, windowStartedAt: number, now: number): DatabaseStatement {
  return db.prepare(`INSERT INTO device_gateway_rate_limits (bucket_key, window_started_at, request_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      request_count = CASE WHEN device_gateway_rate_limits.window_started_at = excluded.window_started_at
        THEN device_gateway_rate_limits.request_count + 1 ELSE 1 END,
      updated_at = excluded.updated_at`).bind(bucketKey, windowStartedAt, now);
}

export async function enforceOperatorAuthRateLimit(db: DatabaseBinding, request: Request, kind: AuthRateLimitKind, now = Date.now()) {
  const windowMs = 60_000;
  const windowStartedAt = Math.floor(now / windowMs) * windowMs;
  const address = request.headers.get(TRUSTED_CLIENT_ADDRESS_HEADER)?.trim().slice(0, 128) || "address-unavailable";
  const bucketKey = `auth:${kind}:client:${sha256Hex(address)}`;
  await rateLimitUpsert(db, bucketKey, windowStartedAt, now).run();
  const row = await db.prepare(`SELECT request_count FROM device_gateway_rate_limits
    WHERE bucket_key = ? AND window_started_at = ?`).bind(bucketKey, windowStartedAt).first<{ request_count: number }>();
  if (Number(row?.request_count ?? 0) <= AUTH_RATE_LIMITS[kind]) return null;
  return Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1_000));
}
