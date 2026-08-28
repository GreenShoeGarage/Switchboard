import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("declares SWITCHBOARD product metadata without a development marker", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../app/switchboard-workbench.tsx", import.meta.url), "utf8");
  const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");

  assert.match(layout, /title: "SWITCHBOARD — Microcontroller Command Workbench"/);
  assert.match(layout, /icons: \{ icon: "\/favicon\.svg"/);
  assert.match(workbench, /SIMULATED DEVICE/);
  assert.match(workbench, /SWITCHBOARD COMMUNITY/);
  assert.match(nextConfig, /poweredByHeader: false/);
  assert.doesNotMatch(`${layout}\n${workbench}`, /codex-preview/);
});
