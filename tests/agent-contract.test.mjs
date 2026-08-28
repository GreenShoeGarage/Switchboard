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

async function onlinePhysicalAgent(binding, auth, hardwareId) {
  const enrollment = await auth.createEnrollmentToken(binding, {
    boardProfileId: "arduino-uno-r4-wifi",
    deviceName: "Physical HIL Contract",
    ttlMinutes: 15,
  });
  const exchanged = await auth.exchangeEnrollmentToken(binding, {
    token: enrollment.secret,
    hardwareId,
  });
  const credential = await auth.authenticateDevice(binding, exchanged.device.id, exchanged.credential);
  const session = await auth.openDeviceSession(binding, exchanged.device.id, credential.id);
  await auth.touchDeviceHeartbeat(binding, session.id, exchanged.device.id, {
    agentVersion: "0.8.0-device-workbench-candidate",
    firmwareVersion: "WiFiS3",
    rssiDbm: -48,
    ipAddress: "192.168.1.42",
  });
  return { ...exchanged, session };
}

test("Batch 4 migration adds bounded agent logs and evidence-based HIL records", async () => {
  const database = await migratedDatabase();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ["device_agent_logs", "hardware_test_runs", "hardware_test_steps"]) assert.ok(tables.includes(name));
  const logColumns = database.prepare("PRAGMA table_info(device_agent_logs)").all().map((row) => row.name);
  assert.ok(logColumns.includes("message"));
  assert.ok(!logColumns.includes("credential"));
  assert.ok(!logColumns.includes("password"));
  database.close();
});

test("agent logs redact credential-shaped secrets and remain bounded by contract", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const agent = await vite.ssrLoadModule("/lib/agent-server.ts");
  const physical = await onlinePhysicalAgent(binding, auth, "agent-log-contract-hardware");
  const secret = "swdev_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const token = "swenr_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const recorded = await agent.recordAgentLog(binding, {
    deviceId: physical.device.id,
    sessionId: physical.session.id,
    level: "WARN",
    code: "AUTH_RETRY",
    message: `credential=${secret} token=${token} password=supersecret {"wifiPassword":"alsosecret"}`,
    deviceUptimeMs: 1234,
  });
  assert.doesNotMatch(recorded.message, /swdev_|swenr_|supersecret|alsosecret/);
  assert.match(recorded.message, /REDACTED/);
  assert.equal((await agent.listAgentLogs(binding, physical.device.id, 999)).length, 1);
  const source = await readFile(new URL("../lib/agent-server.ts", import.meta.url), "utf8");
  assert.match(source, /LIMIT 500/);
  assert.match(source, /Math\.min\(200/);
  database.close();
});

test("physical HIL cannot pass without every step, target cycles, and zero failures", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const hil = await vite.ssrLoadModule("/lib/hil-server.ts");
  const model = await vite.ssrLoadModule("/lib/device-model.ts");
  const physical = await onlinePhysicalAgent(binding, auth, "hil-contract-hardware");
  let run = await hil.createHilRun(binding, {
    deviceId: physical.device.id,
    operator: "test-operator",
    targetCycles: 1000,
  });
  assert.equal(run.status, "RUNNING");
  assert.equal(run.steps.length, model.HIL_STEP_KEYS.length);
  const startingConfigurationVersion = run.validatedConfigurationVersion;
  await binding.prepare("UPDATE devices SET configuration_version = configuration_version + 2, control_ready = 1 WHERE id = ?").bind(physical.device.id).run();
  for (const stepKey of model.HIL_STEP_KEYS) {
    run = await hil.updateHilRun(binding, {
      deviceId: physical.device.id,
      runId: run.id,
      stepKey,
      stepStatus: "PASSED",
      observation: `Verified ${stepKey}`,
    });
  }
  assert.equal(run.status, "RUNNING");
  run = await hil.updateHilRun(binding, {
    deviceId: physical.device.id,
    runId: run.id,
    completedCycles: 1000,
    failureCount: 0,
  });
  assert.equal(run.status, "PASSED");
  assert.ok(run.completedAt > 0);
  assert.equal(run.validatedConfigurationVersion, startingConfigurationVersion + 2);
  database.close();
});

test("simulators cannot create physical Hardware-in-the-Loop evidence", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const hil = await vite.ssrLoadModule("/lib/hil-server.ts");
  const simulator = await registry.createSimulator(binding, { id: "SIM-NO-HIL", name: "No HIL" });
  await assert.rejects(
    hil.createHilRun(binding, { deviceId: simulator.id, operator: "test-operator" }),
    /physical device/,
  );
  database.close();
});

test("a reported agent or firmware change invalidates an active physical HIL run", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const hil = await vite.ssrLoadModule("/lib/hil-server.ts");
  const physical = await onlinePhysicalAgent(binding, auth, "hil-identity-change-hardware");
  const run = await hil.createHilRun(binding, { deviceId: physical.device.id, operator: "test-operator" });
  await auth.touchDeviceHeartbeat(binding, physical.session.id, physical.device.id, {
    agentVersion: "0.8.1-different-build", firmwareVersion: "WiFiS3",
  });
  assert.equal((await hil.getHilRun(binding, physical.device.id, run.id)).status, "ABORTED");
  database.close();
});

test("published UNO R4 candidate matches the canonical source and provisioning protocol", async () => {
  const canonical = await readFile(new URL("../firmware/uno-r4-wifi/SwitchboardAgent/SwitchboardAgent.ino", import.meta.url), "utf8");
  const published = await readFile(new URL("../public/firmware/SWITCHBOARD-Agent-v0.8.0.ino", import.meta.url), "utf8");
  const setup = await readFile(new URL("../scripts/setup-firmware-toolchain.sh", import.meta.url), "utf8");
  assert.equal(published, canonical);
  assert.doesNotMatch(canonical, /device\.hello/);
  assert.match(canonical, /\/api\/device-enrollment\/exchange/);
  assert.match(canonical, /device\.authenticate/);
  assert.match(canonical, /device\.heartbeat/);
  assert.match(canonical, /localFailsafe/);
  assert.match(canonical, /SAFE_INPUT_BOOT/);
  assert.match(canonical, /device\.snapshot/);
  assert.match(canonical, /device\.command\.poll/);
  assert.match(canonical, /snapshotAccepted/);
  assert.match(canonical, /gpio\.ack/);
  assert.match(canonical, /device\.log/);
  assert.match(canonical, /pinMode\(managedPins\[index\]\.hardwarePin, INPUT\)/);
  assert.match(canonical, /memset\(config\.enrollmentToken/);
  assert.match(canonical, /RETRY_MAX_MS = 60000/);
  assert.match(canonical, /agent\.identity/);
  assert.match(canonical, /agent\.provisioned/);
  assert.match(canonical, /agent\.cleared/);
  assert.match(canonical, /Serial\.flush\(\)/);
  assert.match(canonical, /analogReadResolution\(14\)/);
  assert.match(canonical, /analogWriteResolution\(12\)/);
  assert.match(canonical, /WRITE_PWM/);
  assert.match(canonical, /WRITE_DAC/);
  assert.match(setup, /arduino:renesas_uno@1\.5\.2/);
  assert.match(setup, /ArduinoJson@7\.4\.3/);
  assert.match(setup, /WebSockets@2\.7\.2/);
  assert.match(setup, /ArduinoHttpClient@0\.6\.1/);
});
