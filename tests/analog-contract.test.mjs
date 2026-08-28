import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createDatabaseBinding, migratedDatabase } from "./support/database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => { await vite.close(); });

test("Batch 6 migration adds traceable bounded telemetry storage", async () => {
  const database = await migratedDatabase();
  const columns = database.prepare("PRAGMA table_info(device_telemetry_samples)").all().map((row) => row.name);
  for (const column of ["pin_id", "raw_value", "voltage_value", "engineering_value", "engineering_unit", "recorded_at"]) assert.ok(columns.includes(column));
  const pinColumns = database.prepare("PRAGMA table_info(device_pins)").all().map((row) => row.name);
  assert.ok(pinColumns.includes("confirmed_raw_value")); assert.ok(pinColumns.includes("sampled_at"));
  const indexes = database.prepare("PRAGMA index_list(device_telemetry_samples)").all().map((row) => row.name);
  assert.ok(indexes.includes("device_telemetry_pin_time_idx"));
  database.close();
});

test("14-bit raw samples retain voltage and deterministic engineering scaling", async () => {
  const telemetry = await vite.ssrLoadModule("/lib/telemetry-server.ts");
  const pin = { engineeringUnit: "PSI", scaleInputLow: 0.5, scaleOutputLow: 0, scaleInputHigh: 4.5, scaleOutputHigh: 100 };
  const raw = telemetry.rawFromEngineering("arduino-uno-r4-wifi", pin, 50);
  const scaled = telemetry.scaleAnalogRaw("arduino-uno-r4-wifi", pin, raw);
  assert.equal(scaled.bits, 14); assert.equal(scaled.maximumRaw, 16383);
  assert.ok(Math.abs(scaled.voltageValue - 2.5) < 0.001);
  assert.ok(Math.abs(scaled.engineeringValue - 50) < 0.02);
  assert.equal(scaled.engineeringUnit, "PSI");
  assert.throws(() => telemetry.scaleAnalogRaw("arduino-uno-r4-wifi", pin, 16384), /14-bit/);
});

test("PWM and DAC commands require capability, exact 12-bit values, and acknowledgment", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const gpio = await vite.ssrLoadModule("/lib/gpio-server.ts");
  const device = await registry.createSimulator(binding, { id: "SIM-ANALOG-COMMANDS", name: "Analog Contract" });
  let command = await gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "D5", kind: "WRITE_PWM", requestedValue: 2048, actor: "test-operator" });
  command = await gpio.executeServerSimulatorCommand(binding, device.id, command.id);
  assert.equal(command.status, "ACKNOWLEDGED"); assert.equal(command.confirmedMode, "PWM"); assert.equal(command.confirmedValue, 2048);
  let mode = await gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "A0", kind: "SET_MODE", requestedMode: "DAC", actor: "test-operator" });
  mode = await gpio.executeServerSimulatorCommand(binding, device.id, mode.id);
  assert.equal(mode.status, "ACKNOWLEDGED"); assert.equal(mode.confirmedMode, "DAC");
  let dac = await gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "A0", kind: "WRITE_DAC", requestedValue: 4095, actor: "test-operator" });
  dac = await gpio.executeServerSimulatorCommand(binding, device.id, dac.id);
  assert.equal(dac.status, "ACKNOWLEDGED"); assert.equal(dac.confirmedValue, 4095);
  await assert.rejects(gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "D7", kind: "SET_MODE", requestedMode: "PWM", actor: "test" }), /does not support PWM/);
  await assert.rejects(gpio.issueGpioCommand(binding, { deviceId: device.id, pinId: "A0", kind: "WRITE_DAC", requestedValue: 4096, actor: "test" }), /12-bit/);
  database.close();
});

test("physical analog snapshots persist raw, voltage, engineering value, and retention metadata", async () => {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const auth = await vite.ssrLoadModule("/lib/device-auth.ts");
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const telemetry = await vite.ssrLoadModule("/lib/telemetry-server.ts");
  const issued = await auth.createEnrollmentToken(binding, { boardProfileId: "arduino-uno-r4-wifi", deviceName: "Analog Physical", ttlMinutes: 15 });
  const exchange = await auth.exchangeEnrollmentToken(binding, { token: issued.secret, hardwareId: "analog-physical-contract" });
  const credential = await auth.authenticateDevice(binding, exchange.device.id, exchange.credential);
  const session = await auth.openDeviceSession(binding, exchange.device.id, credential.id);
  await binding.prepare("UPDATE device_pins SET engineering_unit = 'PSI', scale_input_low = 0.5, scale_output_low = 0, scale_input_high = 4.5, scale_output_high = 100 WHERE device_id = ? AND pin_id = 'A0'").bind(exchange.device.id).run();
  const snapshotPins = (await registry.getDevicePins(binding, exchange.device.id)).map((pin) => ({
    pinId: pin.pinId, mode: pin.pinId.startsWith("A") ? "ANALOG" : "INPUT", value: pin.pinId === "A0" ? 8192 : 0,
  }));
  await auth.recordDeviceSnapshot(binding, session.id, exchange.device.id, 1, { pins: snapshotPins });
  const samples = await telemetry.listTelemetrySamples(binding, exchange.device.id, "A0", 10);
  assert.equal(samples.length, 1); assert.equal(samples[0].rawValue, 8192); assert.equal(samples[0].engineeringUnit, "PSI");
  assert.ok(Math.abs(samples[0].voltageValue - 2.5) < 0.001); assert.ok(Math.abs(samples[0].engineeringValue - 50) < 0.02);
  database.close();
});
