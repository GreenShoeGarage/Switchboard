import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("Batch 1 migration creates the persistent registry and cascades sample data", async () => {
  const migration = await readFile(new URL("../drizzle/0000_curvy_maximus.sql", import.meta.url), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const name of ["devices", "device_groups", "device_pins", "device_connection_events"]) assert.ok(tables.includes(name));

  db.exec("INSERT INTO devices (id, name, board_profile_id, kind, simulated) VALUES ('SIM-TEST', 'Test', 'arduino-uno-r4-wifi', 'SIMULATED', 1)");
  db.exec("INSERT INTO device_pins (device_id, pin_id) VALUES ('SIM-TEST', 'D7')");
  db.exec("INSERT INTO device_connection_events (device_id, state) VALUES ('SIM-TEST', 'ONLINE')");
  db.exec("DELETE FROM devices WHERE id = 'SIM-TEST'");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM device_pins").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM device_connection_events").get().count, 0);
  db.close();
});

test("registry APIs are SQLite-backed and expose all Batch 1 boundaries", async () => {
  const sqlite = await readFile(new URL("../db/sqlite.ts", import.meta.url), "utf8");
  const server = await readFile(new URL("../server/community-server.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../lib/registry-server.ts", import.meta.url), "utf8");
  const simulatorRoute = await readFile(new URL("../app/api/devices/[id]/simulate/route.ts", import.meta.url), "utf8");
  const configRoute = await readFile(new URL("../app/api/devices/[id]/configuration/route.ts", import.meta.url), "utf8");
  const profileLoader = await readFile(new URL("../lib/board-profiles.ts", import.meta.url), "utf8");

  assert.match(sqlite, /journal_mode = WAL/);
  assert.match(sqlite, /applySQLiteMigrations/);
  assert.match(server, /setDatabase\(database\)/);
  assert.match(registry, /device_connection_events/);
  assert.match(registry, /RECONNECTING/);
  assert.match(simulatorRoute, /DEVICE_OFFLINE/);
  assert.match(simulatorRoute, /DEVICE_IN_MAINTENANCE/);
  assert.match(configRoute, /switchboard\.config\.v2/);
  assert.match(configRoute, /switchboard\.config\.v3/);
  assert.match(configRoute, /switchboard\.config\.v4/);
  assert.match(configRoute, /serverSafeValue/);
  assert.match(configRoute, /secretsIncluded: false/);
  assert.match(profileLoader, /safeParse/);
  assert.match(profileLoader, /Duplicate pin id/);
});

test("device registry overflow control exposes device actions", async () => {
  const workbench = await readFile(new URL("../app/switchboard-workbench.tsx", import.meta.url), "utf8");

  assert.match(workbench, /aria-label={`Actions for \${device\.name}`}/);
  assert.match(workbench, /<DropdownMenuTrigger asChild>/);
  assert.match(workbench, /OPEN WORKBENCH/);
  assert.match(workbench, /OPEN MONITOR/);
  assert.match(workbench, /OPEN TRANSPORT/);
  assert.doesNotMatch(workbench, /<span><MoreHorizontal \/><\/span><\/button>/);
});
