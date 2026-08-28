import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Batch 2 migration creates revocable transport records", async () => {
  const database = await migratedDatabase();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ["enrollment_tokens", "device_credentials", "device_sessions", "device_state_snapshots"]) {
    assert.ok(tables.includes(name));
  }
  const credentialColumns = database.prepare("PRAGMA table_info(device_credentials)").all().map((row) => row.name);
  assert.ok(credentialColumns.includes("secret_hash"));
  assert.ok(credentialColumns.includes("revoked_at"));
  assert.ok(!credentialColumns.includes("secret"));
  database.close();
});

test("enrollment secrets are one-time and device credentials are revocable", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");

  const enrollment = await auth.createEnrollmentToken(binding, {
    boardProfileId: "arduino-uno-r4-wifi",
    deviceName: "Transport Contract",
    ttlMinutes: 15,
  });
  assert.match(enrollment.secret, /^swenr_/);
  const tokenRow = database.prepare("SELECT token_hash, token_prefix FROM enrollment_tokens WHERE id = ?").get(enrollment.record.id);
  assert.notEqual(tokenRow.token_hash, enrollment.secret);
  assert.ok(!tokenRow.token_prefix.includes(enrollment.secret));

  const exchanged = await auth.exchangeEnrollmentToken(binding, {
    token: enrollment.secret,
    hardwareId: "transport-contract-hardware-id",
    simulated: true,
  });
  assert.match(exchanged.credential, /^swdev_/);
  assert.equal((await auth.authenticateDevice(binding, exchanged.device.id, exchanged.credential)).id, exchanged.credentialId);
  await assert.rejects(
    auth.exchangeEnrollmentToken(binding, {
      token: enrollment.secret,
      hardwareId: "another-hardware-id",
      simulated: true,
    }),
    /already used/,
  );

  await auth.revokeCredential(binding, exchanged.device.id, exchanged.credentialId);
  assert.equal(await auth.authenticateDevice(binding, exchanged.device.id, exchanged.credential), null);
  const storedCredential = database.prepare("SELECT secret_hash, revoked_at FROM device_credentials WHERE id = ?").get(exchanged.credentialId);
  assert.notEqual(storedCredential.secret_hash, exchanged.credential);
  assert.ok(storedCredential.revoked_at > 0);
  database.close();
});

test("WebSocket and browser reconnect contracts stay bounded", async () => {
  const socket = await readFile(new URL("../lib/device-socket-server.ts", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../lib/device-gateway.ts", import.meta.url), "utf8");
  const server = await readFile(new URL("../server/community-server.ts", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../app/transport-workbench.tsx", import.meta.url), "utf8");

  assert.match(gateway, /DEVICE_SOCKET_PATH = "\/api\/device\/socket"/);
  assert.match(server, /url\.pathname === DEVICE_SOCKET_PATH/);
  assert.match(server, /webSockets\.handleUpgrade/);
  assert.match(server, /attachDeviceSocket/);
  assert.match(socket, /message\.type !== "device\.authenticate"/);
  assert.match(socket, /Protocol version mismatch/);
  assert.match(socket, /credentialIsActive/);
  assert.match(socket, /sessionIsConnected/);
  assert.match(socket, /device\.heartbeat\.ack/);
  assert.match(socket, /device\.snapshot\.ack/);
  assert.match(workbench, /RECONNECT_DELAYS = \[1_000, 2_000, 4_000, 8_000, 8_000\]/);
});
