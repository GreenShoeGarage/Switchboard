import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true },
});

after(async () => { await vite.close(); });

test("candidate manifest pins the UNO R4 upload strategy and verifies its published source", async () => {
  const manifestValue = JSON.parse(await readFile(new URL("../public/firmware/manifest-v1.json", import.meta.url), "utf8"));
  const source = new Uint8Array(await readFile(new URL("../public/firmware/SWITCHBOARD-Agent-v0.8.0.ino", import.meta.url)));
  const firmware = await vite.ssrLoadModule("/lib/firmware-manifest.ts");
  const manifest = firmware.validateFirmwareManifest(manifestValue);
  assert.equal(manifest.release, "0.8.0-candidate");
  assert.equal(manifest.agentVersion, "0.8.0-device-workbench-candidate");
  assert.equal(manifest.source.url, "/firmware/SWITCHBOARD-Agent-v0.8.0.ino");
  assert.equal(manifest.board.profileId, "arduino-uno-r4-wifi");
  assert.equal(manifest.upload.strategy, "bossac-samba-extended");
  assert.equal(manifest.upload.reset, "1200-bps-touch");
  assert.equal(manifest.upload.bootloaderBaud, 921600);
  assert.equal(manifest.upload.maximumBytes, 262144);
  assert.equal(manifest.binary, null);
  assert.equal(manifest.hardwareVerification.passed, false);
  assert.equal(await firmware.verifyFirmwareAsset(source, manifest.source), true);
});

test("USB identity recognizes only documented UNO R4 WiFi runtime and bootloader IDs", async () => {
  const firmware = await vite.ssrLoadModule("/lib/firmware-manifest.ts");
  assert.equal(firmware.classifyUnoR4Usb(0x2341, 0x1002), "runtime");
  assert.equal(firmware.classifyUnoR4Usb(0x2341, 0x006d), "bootloader");
  assert.equal(firmware.classifyUnoR4Usb(0x2341, 0x9999), "unknown");
});

test("browser erase and write remain locked before binary and physical HIL evidence", async () => {
  const { WebSerialFlasher } = await vite.ssrLoadModule("/lib/flasher/web-serial.ts");
  const flasher = new WebSerialFlasher({ getInfo: () => ({ usbVendorId: 0x2341, usbProductId: 0x1002 }) });
  await assert.rejects(flasher.prepare({
    boardProfile: "arduino-uno-r4-wifi", version: "0.8.0-candidate", protocolVersion: 1,
    sha256: "0".repeat(64), bytes: new Uint8Array(), verified: false,
    hardwareVerified: false, hilRunId: null,
  }), (error) => error?.code === "PACKAGE_UNAVAILABLE");
  const source = await readFile(new URL("../lib/flasher/web-serial.ts", import.meta.url), "utf8");
  assert.match(source, /baudRate: 1200/);
  assert.match(source, /PACKAGE_NOT_VERIFIED/);
  assert.match(source, /requestPort\(\{ filters:/);
});
