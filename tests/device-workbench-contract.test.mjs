import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createDatabaseBinding, migratedDatabase } from "./support/database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => { await vite.close(); });

async function physicalFixture(binding, auth, hardwareId) {
  const enrollment = await auth.createEnrollmentToken(binding, { boardProfileId: "arduino-uno-r4-wifi", deviceName: "Batch 7 Physical", ttlMinutes: 15 });
  const exchange = await auth.exchangeEnrollmentToken(binding, { token: enrollment.secret, hardwareId });
  const credential = await auth.authenticateDevice(binding, exchange.device.id, exchange.credential);
  const session = await auth.openDeviceSession(binding, exchange.device.id, credential.id);
  return { ...exchange, credential, session };
}

async function fullSnapshot(registry, binding, deviceId) {
  return (await registry.getDevicePins(binding, deviceId)).map((pin) => ({
    pinId: pin.pinId,
    mode: pin.pinId.startsWith("A") ? "ANALOG" : "INPUT",
    value: pin.pinId.startsWith("A") ? 7_000 : 0,
  }));
}

test("Batch 7 migration adds control, safe-state, and provenance storage", async () => {
  const database = await migratedDatabase();
  const deviceColumns = database.prepare("PRAGMA table_info(devices)").all().map((row) => row.name);
  for (const column of ["monitor_only", "control_ready", "firmware_failsafe_mode", "firmware_failsafe_timeout_ms", "firmware_failsafe_reported_at"]) assert.ok(deviceColumns.includes(column));
  assert.ok(database.prepare("PRAGMA table_info(device_pins)").all().some((row) => row.name === "server_safe_value"));
  const commandColumns = database.prepare("PRAGMA table_info(gpio_commands)").all().map((row) => row.name);
  for (const column of ["origin", "safe_state_run_id"]) assert.ok(commandColumns.includes(column));
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_safe_state_runs'").get());
  assert.ok(database.prepare("PRAGMA index_list(gpio_commands)").all().some((row) => row.name === "gpio_commands_safe_state_run_idx"));
  database.close();
});

test("physical control requires a complete snapshot from the claiming session", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const physical = await physicalFixture(binding, auth, "batch7-control-ready");
  assert.equal((await registry.getDevice(binding, physical.device.id)).controlReady, false);
  await assert.rejects(gpio.issueGpioCommand(binding, { deviceId: physical.device.id, pinId: "D7", kind: "SET_MODE", requestedMode: "OUTPUT", actor: "test" }), /DEVICE_NOT_SYNCHRONIZED/);
  await assert.rejects(auth.recordDeviceSnapshot(binding, physical.session.id, physical.device.id, 1, { pins: [{ pinId: "D7", mode: "INPUT", value: 0 }] }), /complete, unique/);
  await auth.touchDeviceHeartbeat(binding, physical.session.id, physical.device.id, { agentVersion: "0.8.0-device-workbench-candidate", localFailsafe: { mode: "SAFE_INPUT_BOOT", timeoutMs: null } });
  await auth.recordDeviceSnapshot(binding, physical.session.id, physical.device.id, 2, { pins: await fullSnapshot(registry, binding, physical.device.id) });
  let device = await registry.getDevice(binding, physical.device.id);
  assert.equal(device.controlReady, true); assert.equal(device.firmwareFailsafeMode, "SAFE_INPUT_BOOT");

  const second = await auth.openDeviceSession(binding, physical.device.id, physical.credential.id);
  const command = await gpio.issueGpioCommand(binding, { deviceId: physical.device.id, pinId: "D7", kind: "SET_MODE", requestedMode: "OUTPUT", actor: "test" });
  assert.equal(await gpio.claimNextGpioCommand(binding, physical.device.id, second.id), null);
  assert.equal((await gpio.claimNextGpioCommand(binding, physical.device.id, physical.session.id)).id, command.id);
  await auth.closeDeviceSession(binding, physical.session.id, physical.device.id, 1000, "test close");
  await auth.closeDeviceSession(binding, second.id, physical.device.id, 1000, "test close");
  device = await registry.getDevice(binding, physical.device.id);
  assert.equal(device.controlReady, false); assert.equal(device.connectionState, "OFFLINE");
  database.close();
});

test("Monitor Only and Maintenance Mode fence queued and new commands", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const dbModule = await vite.ssrLoadModule("/db/index.ts"); dbModule.setDatabase(binding);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const deviceRoute = await vite.ssrLoadModule("/app/api/devices/[id]/route.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-BATCH7-LOCK", name: "Lock Contract" });
  const queued = await gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "D7", kind: "WRITE", requestedValue: 1, actor: "test" });
  let response = await deviceRoute.PATCH(new Request("https://switchboard.test/api/devices/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ monitorOnly: true }) }), { params: Promise.resolve({ id: device.id }) });
  assert.equal(response.status, 200);
  assert.equal((await gpio.getGpioCommand(binding, device.id, queued.id)).status, "FAILED");
  await assert.rejects(gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "D7", kind: "WRITE", requestedValue: 0, actor: "test" }), /DEVICE_MONITOR_ONLY/);

  response = await deviceRoute.PATCH(new Request("https://switchboard.test", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maintenanceMode: true }) }), { params: Promise.resolve({ id: device.id }) });
  assert.equal(response.status, 200);
  response = await deviceRoute.PATCH(new Request("https://switchboard.test", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maintenanceMode: false }) }), { params: Promise.resolve({ id: device.id }) });
  assert.equal(response.status, 200);
  const latched = (await response.json()).device;
  assert.equal(latched.maintenanceMode, false); assert.equal(latched.monitorOnly, true);
  database.close();
});

test("server safe-state profile is traceable and succeeds only after exact acknowledgments", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const safety = await vite.ssrLoadModule("/lib/safety-server.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-BATCH7-SAFE", name: "Safe State Contract" });
  const created = await safety.createSafeStateRun(binding, { deviceId: device.id, actor: "test-operator" });
  assert.equal(created.commands.length, 3);
  assert.deepEqual(new Set(created.commands.map((command) => command.pinId)), new Set(["D5", "D7", "D8"]));
  for (const command of created.commands) {
    assert.equal(command.origin, "SERVER_SAFE_STATE"); assert.equal(command.safeStateRunId, created.run.id);
    await gpio.executeServerSimulatorCommand(binding, device.id, command.id);
  }
  const run = await safety.refreshSafeStateRun(binding, device.id, created.run.id);
  assert.equal(run.status, "ACKNOWLEDGED"); assert.equal(run.acknowledgedCount, 3); assert.equal(run.targetCount, 3);
  database.close();
});

test("agent log query/export and browser-local serial console fail closed", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const dbModule = await vite.ssrLoadModule("/db/index.ts"); dbModule.setDatabase(binding);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const agent = await vite.ssrLoadModule("/lib/agent-server.ts");
  const logsRoute = await vite.ssrLoadModule("/app/api/devices/[id]/logs/route.ts");
  const serial = await vite.ssrLoadModule("/app/serial-console.tsx");
  const webSerial = await vite.ssrLoadModule("/lib/flasher/web-serial.ts");
  const physical = await physicalFixture(binding, auth, "batch7-log-export");
  await agent.recordAgentLog(binding, { deviceId: physical.device.id, sessionId: physical.session.id, level: "WARN", code: "FORMULA", message: "=2+2", deviceUptimeMs: 20 });
  let response = await logsRoute.GET(new Request(`https://switchboard.test/api/devices/${physical.device.id}/logs?level=debug`), { params: Promise.resolve({ id: physical.device.id }) });
  assert.equal(response.status, 400);
  response = await logsRoute.GET(new Request(`https://switchboard.test/api/devices/${physical.device.id}/logs?format=csv&limit=NaN`), { params: Promise.resolve({ id: physical.device.id }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(await response.text(), /'=2\+2/);
  assert.equal(serial.safeConsoleCommand('{"action":"status"}'), '{"action":"status"}');
  assert.throws(() => serial.safeConsoleCommand('{"action":"clear"}'), /only status and identify/);
  assert.throws(() => serial.safeConsoleCommand('{"action":"status","token":"swdev_secret"}'), /Secrets are blocked/);
  assert.doesNotMatch(webSerial.redactSerialText('password="hello world" Bearer abc.def'), /hello world|abc\.def/);
  database.close();
});

test("workbench exposes all Batch 7 tools and wires advanced navigation", async () => {
  const workbench = await readFile(new URL("../app/device-workbench.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("../app/switchboard-workbench.tsx", import.meta.url), "utf8");
  const serialSource = await readFile(new URL("../lib/flasher/web-serial.ts", import.meta.url), "utf8");
  for (const label of ["Board + Pins", "Details", "USB Console", "Agent Logs", "Safety"]) assert.match(workbench, new RegExp(label.replace("+", "\\+")));
  assert.match(shell, /openDeviceWorkbench\("logs"\)/); assert.match(shell, /openDeviceWorkbench\("details"\)/);
  assert.match(serialSource, /OVERSIZED SERIAL LINE DISCARDED/); assert.match(serialSource, /baudRate: 115200/);
});
