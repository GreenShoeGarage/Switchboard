import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SwitchboardDeviceSimulator } from "../server/simulator.mjs";

test("UNO R4 WiFi profile has unique pins and expected core capabilities", async () => {
  const profile = JSON.parse(await readFile(new URL("../board-profiles/arduino-uno-r4-wifi.json", import.meta.url), "utf8"));
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.protocolVersion, 1);
  assert.equal(profile.id, "arduino-uno-r4-wifi");
  assert.equal(new Set(profile.pins.map((pin) => pin.id)).size, profile.pins.length);
  assert.ok(profile.pins.find((pin) => pin.id === "D7")?.capabilities.includes("digital-output"));
  assert.ok(profile.pins.find((pin) => pin.id === "A0")?.capabilities.includes("dac-output"));
});

test("simulator refuses offline commands", async () => {
  const device = new SwitchboardDeviceSimulator({ latencyMs: 1 });
  await assert.rejects(device.command({ commandId: "cmd-1", pin: "D7", value: 1 }), /DEVICE_OFFLINE/);
});

test("simulator acknowledges confirmed output state", async () => {
  const device = new SwitchboardDeviceSimulator({ latencyMs: 1 });
  device.connect();
  const acknowledgment = await device.command({ commandId: "cmd-2", pin: "D7", value: 1 });
  assert.equal(acknowledgment.commandId, "cmd-2");
  assert.equal(acknowledgment.confirmedValue, 1);
});

test("visible release version matches package version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const model = await readFile(new URL("../lib/device-model.ts", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../app/switchboard-workbench.tsx", import.meta.url), "utf8");
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.equal(packageJson.version, "0.10.0");
  assert.match(model, /APP_VERSION = "0\.10\.0"/);
  assert.match(model, /DATABASE_SCHEMA_VERSION = 9/);
  assert.match(model, /TRANSPORT_PROTOCOL_VERSION = 1/);
  assert.match(workbench, /APP_VERSION/);
  assert.match(changelog, /\[0\.10\.0\]/);
});
