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

test("Batch 3 migration adds a bounded persistent GPIO command ledger", async () => {
  const database = await migratedDatabase();
  const columns = database.prepare("PRAGMA table_info(gpio_commands)").all().map((row) => row.name);
  for (const column of ["requested_value", "confirmed_value", "status", "deadline_at", "latency_ms", "error"]) {
    assert.ok(columns.includes(column));
  }
  const indexes = database.prepare("PRAGMA index_list(gpio_commands)").all().map((row) => row.name);
  assert.ok(indexes.includes("gpio_commands_status_deadline_idx"));
  database.close();
});

test("server simulator keeps requested and confirmed output state separate until acknowledgment", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-GPIO-ACK", name: "GPIO Contract" });

  const issued = await gpio.issueGpioCommand(binding, {
    deviceId: device.id, pinId: "D7", kind: "WRITE", requestedValue: 1, actor: "test-operator",
  });
  assert.equal(issued.status, "QUEUED");
  let pin = (await registry.getDevicePins(binding, device.id)).find((candidate) => candidate.pinId === "D7");
  assert.equal(pin.requestedValue, 1);
  assert.equal(pin.confirmedValue, 0);

  const acknowledged = await gpio.executeServerSimulatorCommand(binding, device.id, issued.id);
  assert.equal(acknowledged.status, "ACKNOWLEDGED");
  assert.ok(acknowledged.latencyMs >= 0);
  pin = (await registry.getDevicePins(binding, device.id)).find((candidate) => candidate.pinId === "D7");
  assert.equal(pin.requestedValue, null);
  assert.equal(pin.confirmedValue, 1);
  database.close();
});

test("mode acknowledgments update confirmed mode and mismatched output acknowledgments fail closed", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-GPIO-MODE", name: "Mode Contract" });

  const modeCommand = await gpio.issueGpioCommand(binding, {
    deviceId: device.id, pinId: "D2", kind: "SET_MODE", requestedMode: "OUTPUT", actor: "test-operator",
  });
  await gpio.executeServerSimulatorCommand(binding, device.id, modeCommand.id);
  let pin = (await registry.getDevicePins(binding, device.id)).find((candidate) => candidate.pinId === "D2");
  assert.equal(pin.mode, "OUTPUT");
  const confirmedBeforeMismatch = pin.confirmedValue;

  const writeCommand = await gpio.issueGpioCommand(binding, {
    deviceId: device.id, pinId: "D2", kind: "WRITE", requestedValue: 0, actor: "test-operator",
  });
  database.prepare("UPDATE gpio_commands SET status = 'DELIVERED', delivered_at = ? WHERE id = ?").run(Date.now(), writeCommand.id);
  const failed = await gpio.acknowledgeGpioCommand(binding, {
    deviceId: device.id, commandId: writeCommand.id, pinId: "D2",
    confirmedMode: "OUTPUT", confirmedValue: 1, deviceTimestampMs: Date.now(),
  });
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error, /did not match/);
  pin = (await registry.getDevicePins(binding, device.id)).find((candidate) => candidate.pinId === "D2");
  assert.equal(pin.confirmedValue, confirmedBeforeMismatch);
  database.close();
});

test("unacknowledged commands time out without changing confirmed state", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-GPIO-TIMEOUT", name: "Timeout Contract" });
  const command = await gpio.issueGpioCommand(binding, {
    deviceId: device.id, pinId: "D7", kind: "WRITE", requestedValue: 1, actor: "test-operator",
  });
  await assert.rejects(gpio.issueGpioCommand(binding, {
    deviceId: device.id, pinId: "D7", kind: "WRITE", requestedValue: 0, actor: "test-operator",
  }), /PIN_COMMAND_PENDING/);
  database.prepare("UPDATE gpio_commands SET deadline_at = ? WHERE id = ?").run(Date.now() - 1, command.id);
  const expired = await gpio.getGpioCommand(binding, device.id, command.id);
  assert.equal(expired.status, "TIMED_OUT");
  assert.match(expired.error, /timeout/);
  const pin = (await registry.getDevicePins(binding, device.id)).find((candidate) => candidate.pinId === "D7");
  assert.equal(pin.confirmedValue, 0);
  assert.equal(pin.pendingCommandId, null);
  database.close();
});

test("authenticated socket polls commands and validates GPIO acknowledgments", async () => {
  const socket = await readFile(new URL("../lib/device-socket-server.ts", import.meta.url), "utf8");
  const transport = await readFile(new URL("../app/transport-workbench.tsx", import.meta.url), "utf8");
  const pinsRoute = await readFile(new URL("../app/api/devices/[id]/pins/route.ts", import.meta.url), "utf8");
  const configurationRoute = await readFile(new URL("../app/api/devices/[id]/configuration/route.ts", import.meta.url), "utf8");
  assert.match(socket, /device\.command\.poll/);
  assert.match(socket, /claimNextGpioCommand/);
  assert.match(socket, /message\.type === "gpio\.ack"/);
  assert.match(transport, /type: "gpio\.ack"/);
  assert.doesNotMatch(pinsRoute, /confirmedValue\?:/);
  assert.match(pinsRoute, /Pin mode changes require an acknowledged device command/);
  assert.match(configurationRoute, /requires an acknowledged device command/);
});
