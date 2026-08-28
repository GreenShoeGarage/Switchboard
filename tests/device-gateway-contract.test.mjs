import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createDatabaseBinding, migratedDatabase } from "./support/database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

test("external traffic is restricted to the two exact device routes", async () => {
  const gateway = await vite.ssrLoadModule("/lib/device-gateway.ts");
  assert.equal(gateway.deviceGatewayKind("/api/device-enrollment/exchange"), "enrollment");
  assert.equal(gateway.deviceGatewayKind("/api/device/socket"), "socket");
  assert.equal(gateway.deviceGatewayKind("/api/devices"), null);
  assert.equal(gateway.deviceGatewayKind("/api/device/socket/"), null);
  assert.equal(gateway.isCommunityAuthPath("/login"), true);
  assert.equal(gateway.isCommunityAuthPath("/setup"), true);
  assert.equal(gateway.isCommunityAuthPath("/api/auth/status"), true);
  assert.equal(gateway.isCommunityAuthPath("/api/devices"), false);

  let response = gateway.deviceGatewayMethodResponse(
    new Request("https://switchboard.test/api/device/socket", { method: "POST" }),
    "socket",
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");

  response = gateway.deviceGatewayMethodResponse(
    new Request("https://switchboard.test/api/device-enrollment/exchange", { method: "GET" }),
    "enrollment",
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("community owner setup stores password and sessions as hashes", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/operator-auth.ts");
  const bootstrapToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const password = "correct-horse-battery-staple";
  const owner = await auth.createInitialOwner(binding, {
    bootstrapToken,
    configuredBootstrapToken: bootstrapToken,
    email: " Owner@Example.com ",
    password,
    publicBaseUrl: "https://switchboard.example.com/",
  });
  assert.equal(owner.email, "owner@example.com");
  assert.equal(owner.role, "OWNER");
  assert.equal(await auth.installationIsConfigured(binding), true);
  assert.equal(await auth.installationPublicBaseUrl(binding), "https://switchboard.example.com");
  const storedUser = database.prepare("SELECT password_hash FROM operator_users WHERE id = ?").get(owner.id);
  assert.notEqual(storedUser.password_hash, password);
  assert.match(storedUser.password_hash, /^scrypt\$/);
  assert.equal((await auth.authenticatePassword(binding, owner.email, password)).id, owner.id);
  assert.equal(await auth.authenticatePassword(binding, owner.email, "wrong-password"), null);

  const token = await auth.createOperatorSession(binding, owner.id);
  assert.match(token, /^swsess_/);
  assert.equal((await auth.authenticateOperatorSession(binding, token)).email, owner.email);
  assert.notEqual(database.prepare("SELECT token_hash FROM operator_sessions").get().token_hash, token);
  await auth.revokeOperatorSession(binding, token);
  assert.equal(await auth.authenticateOperatorSession(binding, token), null);
  await assert.rejects(auth.createInitialOwner(binding, {
    bootstrapToken,
    configuredBootstrapToken: bootstrapToken,
    email: "second@example.com",
    password,
    publicBaseUrl: "https://switchboard.example.com",
  }), /already configured/);
  database.close();
});

test("enrollment bodies are JSON-only, bounded, and strict", async () => {
  const gateway = await vite.ssrLoadModule("/lib/device-gateway.ts");

  let parsed = await gateway.readEnrollmentRequest(new Request(
    "https://switchboard.test/api/device-enrollment/exchange",
    { method: "POST", body: "token=x" },
  ));
  assert.equal(parsed.response.status, 415);

  parsed = await gateway.readEnrollmentRequest(new Request(
    "https://switchboard.test/api/device-enrollment/exchange",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "swenr_test", hardwareId: "board-1", extra: true }),
    },
  ));
  assert.equal(parsed.response.status, 400);
  assert.equal((await parsed.response.json()).code, "UNKNOWN_FIELD");

  parsed = await gateway.readEnrollmentRequest(new Request(
    "https://switchboard.test/api/device-enrollment/exchange",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "swenr_test", hardwareId: "board-1" }),
    },
  ));
  assert.deepEqual(parsed.payload, { token: "swenr_test", hardwareId: "board-1" });

  parsed = await gateway.readEnrollmentRequest(new Request(
    "https://switchboard.test/api/device-enrollment/exchange",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(gateway.MAX_ENROLLMENT_BODY_BYTES), hardwareId: "board-1" }),
    },
  ));
  assert.equal(parsed.response.status, 413);
});

test("device gateway limits enrollment attempts without storing raw addresses", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const gateway = await vite.ssrLoadModule("/lib/device-gateway.ts");
  const request = new Request("https://switchboard.test/api/device-enrollment/exchange", {
    method: "POST",
    headers: { "x-switchboard-client-address": "203.0.113.42" },
  });
  const now = 1_800_000_000_000;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal(await gateway.enforceDeviceGatewayRateLimit(binding, request, "enrollment", now), null);
  }
  const limited = await gateway.enforceDeviceGatewayRateLimit(binding, request, "enrollment", now);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");

  const keys = database.prepare("SELECT bucket_key FROM device_gateway_rate_limits").all().map((row) => row.bucket_key);
  assert.ok(keys.some((key) => key.startsWith("enrollment:client:")));
  assert.ok(keys.every((key) => !key.includes("203.0.113.42")));

  assert.equal(await gateway.enforceDeviceGatewayRateLimit(binding, request, "enrollment", now + 60_000), null);
  database.close();
});
