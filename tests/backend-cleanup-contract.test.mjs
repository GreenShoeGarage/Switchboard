import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createDatabaseBinding, migratedDatabase } from "./support/database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => { await vite.close(); });

test("shared API helpers keep private failures structured and non-cacheable", async () => {
  const api = await vite.ssrLoadModule("/lib/api-server.ts");
  const response = api.invalidJsonResponse(api.PRIVATE_NO_STORE);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "Request body must be valid JSON", code: "INVALID_JSON" });

  const actor = api.authenticatedActor(new Request("https://switchboard.test", {
    headers: { "x-switchboard-authenticated-user-email": `  ${"operator".repeat(30)}@example.test  ` },
  }));
  assert.equal(actor.length, 120);
  assert.equal(api.authenticatedActor(new Request("https://switchboard.test")), "owner");
});

test("automation API errors share retry and validation metadata", async () => {
  const automation = await vite.ssrLoadModule("/lib/automation-server.ts");
  const api = await vite.ssrLoadModule("/lib/automation-api.ts");
  const error = new automation.AutomationError("Cooldown active", "COOLDOWN", 429, [
    { path: "cooldownMs", code: "TOO_SOON", message: "Wait before retrying", severity: "ERROR" },
  ], 1_250);
  const response = api.automationErrorResponse(error);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).issues[0].code, "TOO_SOON");
});

test("pin configuration normalization and safety rules are centralized", async () => {
  const pins = await vite.ssrLoadModule("/lib/pin-configuration.ts");
  const current = {
    label: "Pump", mode: "OUTPUT", logicalLowLabel: "OFF", logicalHighLabel: "ON", engineeringUnit: null,
    scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, serverSafeValue: 0,
  };
  const resolved = pins.resolvePinConfiguration(current, { label: `  ${"P".repeat(70)}  `, logicalLowLabel: "  STOP  " });
  assert.equal(resolved.label.length, 60);
  assert.equal(resolved.logicalLowLabel, "STOP");
  assert.equal(pins.calibrationIssue(resolved), null);
  assert.equal(pins.safeStateIssue("OUTPUT", 2), "DIGITAL_RANGE");
  assert.equal(pins.safeStateIssue("PWM", 4096), "ANALOG_RANGE");
  assert.equal(pins.safeStateIssue("INPUT", 0), "NOT_OUTPUT");
  assert.equal(pins.calibrationIssue({ ...resolved, engineeringUnit: "PSI", scaleInputLow: 0.5, scaleOutputLow: 0, scaleInputHigh: 0.5, scaleOutputHigh: 100 }), "DEGENERATE");
  assert.equal(pins.calibrationIssue({ ...resolved, engineeringUnit: "PSI", scaleInputLow: -0.1, scaleOutputLow: 0, scaleInputHigh: 4.5, scaleOutputHigh: 100 }), "INPUT_OUT_OF_RANGE");
});

test("pin and configuration routes reject malformed bodies at the request boundary", async () => {
  const database = await migratedDatabase();
  const binding = createDatabaseBinding(database);
  const db = await vite.ssrLoadModule("/db/index.ts");
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const pinRoute = await vite.ssrLoadModule("/app/api/devices/[id]/pins/route.ts");
  const configurationRoute = await vite.ssrLoadModule("/app/api/devices/[id]/configuration/route.ts");
  db.setDatabase(binding);
  const device = await registry.createSimulator(binding, { id: "SIM-BACKEND-CLEANUP", name: "Backend Cleanup" });
  const context = { params: Promise.resolve({ id: device.id }) };

  let response = await pinRoute.PATCH(new Request(`https://switchboard.test/api/devices/${device.id}/pins`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: "{",
  }), context);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_JSON");

  response = await configurationRoute.PUT(new Request(`https://switchboard.test/api/devices/${device.id}/configuration`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ schema: "switchboard.config.v4", pins: [null] }),
  }), context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid pin configuration/);

  response = await pinRoute.PATCH(new Request(`https://switchboard.test/api/devices/${device.id}/pins`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinId: "D7", label: "  Main Pump  ", logicalLowLabel: "  STOPPED  " }),
  }), context);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.pins.find((pin) => pin.pinId === "D7").label, "Main Pump");
  assert.equal(payload.pins.find((pin) => pin.pinId === "D7").logicalLowLabel, "STOPPED");
  database.close();
});
