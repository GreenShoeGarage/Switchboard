import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createDatabaseBinding, migratedDatabase } from "./support/database.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => { await vite.close(); });

function thresholdDraft(sourceId, targetId, overrides = {}) {
  return {
    name: "Cooling threshold",
    description: "Cross-device acknowledged output",
    actionScope: "SIMULATOR_ONLY",
    trigger: {
      kind: "THRESHOLD", sourceDeviceId: sourceId, sourcePinId: "A1", comparator: "GT",
      thresholdValue: 35, hysteresis: 1, holdForMs: 10_000, maxSampleAgeMs: 30_000,
    },
    actions: [{ targetDeviceId: targetId, targetPinId: "D7", commandKind: "WRITE", requestedValue: 1 }],
    cooldownMs: 5_000, rateLimitCount: 6, rateLimitWindowMs: 60_000, maxChainDepth: 2,
    ...overrides,
  };
}

async function fixture() {
  const database = await migratedDatabase(); const binding = createDatabaseBinding(database);
  const registry = await vite.ssrLoadModule("/lib/registry-server.ts");
  const automation = await vite.ssrLoadModule("/lib/automation-server.ts");
  const source = await registry.createSimulator(binding, { id: "SIM-AUTO-SOURCE", name: "Automation Source" });
  const target = await registry.createSimulator(binding, { id: "SIM-AUTO-TARGET", name: "Automation Target" });
  await binding.prepare("UPDATE devices SET automation_armed = 1 WHERE id = ?").bind(target.id).run();
  return { database, binding, registry, automation, source, target };
}

async function sample(binding, deviceId, value, recordedAt, sequence) {
  await binding.batch([
    binding.prepare("UPDATE device_pins SET confirmed_value = ?, confirmed_raw_value = ?, sampled_at = ?, updated_at = ? WHERE device_id = ? AND pin_id = 'A1'")
      .bind(value, Math.round(value * 100), recordedAt, recordedAt, deviceId),
    binding.prepare(`INSERT INTO device_telemetry_samples
      (device_id, pin_id, sequence, raw_value, voltage_value, engineering_value, engineering_unit, recorded_at)
      VALUES (?, 'A1', ?, ?, ?, ?, '°C', ?)`)
      .bind(deviceId, sequence, Math.round(value * 100), value / 10, value, recordedAt),
  ]);
}

function createInterleavingBinding(binding) {
  let arrivals = 0;
  let release;
  let fallbackTimer;
  const gate = new Promise((resolve) => { release = resolve; });
  function wrap(statement, sql) {
    return {
      bind(...values) { return wrap(statement.bind(...values), sql); },
      all() { return statement.all(); },
      first() { return statement.first(); },
      async run() {
        if (sql.includes("UPDATE automation_rules SET mode = ?, revision = ?")) {
          arrivals += 1;
          if (arrivals === 1) fallbackTimer = setTimeout(release, 1_000);
          if (arrivals === 2) { clearTimeout(fallbackTimer); release(); }
          await gate;
        }
        return statement.run();
      },
    };
  }
  return {
    prepare(sql) { return wrap(binding.prepare(sql), sql); },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

async function queuePhysicalAutomation(context, t0) {
  const { binding, automation, source, target } = context;
  await binding.prepare(`UPDATE devices SET simulated = 0, kind = 'PHYSICAL', agent_version = '0.8.0-device-workbench-candidate',
    firmware_version = '0.8.0-device-workbench-candidate', control_ready = 1, automation_armed = 1 WHERE id = ?`).bind(target.id).run();
  const physical = await binding.prepare("SELECT * FROM devices WHERE id = ?").bind(target.id).first();
  await binding.prepare(`INSERT INTO hardware_test_runs
    (id, device_id, status, agent_version, validated_configuration_version, validated_firmware_version,
      target_cycles, completed_cycles, failure_count, operator, started_at, completed_at)
    VALUES (?, ?, 'PASSED', ?, ?, ?, 1000, 1000, 0, 'test-owner', ?, ?)`)
    .bind(`HIL-${target.id}`, target.id, physical.agent_version, physical.configuration_version, physical.firmware_version, t0, t0).run();
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id, {
    actionScope: "PHYSICAL_CONTROL",
    trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 },
  }), "test-owner", t0);
  const enabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", rule.revision, "test-owner", t0);
  await sample(binding, source.id, 42, t0, 1);
  const execution = (await automation.evaluateAutomationForDevice(binding, source.id, t0))[0];
  assert.equal(execution.status, "QUEUED");
  assert.equal(execution.actions[0].status, "QUEUED");
  return { execution, rule: enabled.rule };
}

test("Batch 8 migration adds durable rule, trigger, action, execution, and command provenance", async () => {
  const database = await migratedDatabase();
  for (const table of ["automation_rules", "automation_triggers", "automation_actions", "automation_executions", "automation_action_runs"]) {
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
  const commandColumns = database.prepare("PRAGMA table_info(gpio_commands)").all().map((row) => row.name);
  for (const column of ["automation_rule_id", "automation_rule_revision", "automation_action_id", "automation_execution_id"]) assert.ok(commandColumns.includes(column));
  const provenanceForeignKeys = new Map(database.prepare("PRAGMA foreign_key_list(gpio_commands)").all()
    .filter((row) => ["automation_rule_id", "automation_action_id", "automation_execution_id"].includes(row.from))
    .map((row) => [row.from, row]));
  assert.equal(provenanceForeignKeys.size, 3);
  for (const column of ["automation_rule_id", "automation_action_id", "automation_execution_id"]) {
    assert.equal(provenanceForeignKeys.get(column)?.on_delete, "SET NULL", `${column} must preserve command history when automation records are pruned`);
  }
  const commandIndexes = database.prepare("PRAGMA index_list(gpio_commands)").all().map((row) => row.name);
  assert.ok(commandIndexes.includes("gpio_commands_automation_rule_status_idx"));
  assert.ok(database.prepare("PRAGMA table_info(devices)").all().some((row) => row.name === "automation_armed"));
  const hilColumns = database.prepare("PRAGMA table_info(hardware_test_runs)").all().map((row) => row.name);
  for (const column of ["validated_configuration_version", "validated_firmware_version"]) assert.ok(hilColumns.includes(column));
  assert.ok(database.prepare("PRAGMA index_list(automation_executions)").all().some((row) => row.name === "automation_executions_rule_event_idx"));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("structured validation rejects executable fields, self loops, and electrically invalid actions", async () => {
  const { database, binding, automation, source, target } = await fixture();
  let result = await automation.validateAutomationDraft(binding, { ...thresholdDraft(source.id, target.id), script: "eval('unsafe')" });
  assert.equal(result.valid, false); assert.ok(result.issues.some((issue) => issue.code === "UNKNOWN_FIELD"));
  result = await automation.validateAutomationDraft(binding, thresholdDraft(source.id, source.id, {
    trigger: { ...thresholdDraft(source.id, target.id).trigger, sourcePinId: "D7" },
  }));
  assert.equal(result.valid, false); assert.ok(result.issues.some((issue) => issue.code === "DIRECT_LOOP"));
  result = await automation.validateAutomationDraft(binding, thresholdDraft(source.id, target.id, {
    actions: [{ targetDeviceId: target.id, targetPinId: "D7", commandKind: "WRITE_PWM", requestedValue: 4000 }],
  }));
  assert.equal(result.valid, false); assert.ok(result.issues.some((issue) => issue.code === "PIN_MODE_MISMATCH"));
  database.close();
});

test("structured validation rejects overlong strings instead of truncating identifiers", async () => {
  const { database, binding, automation, source, target } = await fixture();
  let result = await automation.validateAutomationDraft(binding, thresholdDraft(source.id, target.id, { name: "N".repeat(81) }));
  assert.ok(result.issues.some((issue) => issue.code === "NAME_TOO_LONG"));
  result = await automation.validateAutomationDraft(binding, thresholdDraft(source.id, target.id, {
    description: { unsafe: true },
    trigger: { ...thresholdDraft(source.id, target.id).trigger, sourcePinId: "A12345678" },
    actions: [{ targetDeviceId: `${target.id}${"X".repeat(81)}`, targetPinId: "D12345678", commandKind: "WRITE", requestedValue: 1 }],
  }));
  for (const code of ["DESCRIPTION_INVALID", "SOURCE_PIN_TOO_LONG", "TARGET_DEVICE_TOO_LONG", "TARGET_PIN_TOO_LONG"]) {
    assert.ok(result.issues.some((issue) => issue.code === code), `missing ${code}`);
  }
  database.close();
});

test("dry run records exact evidence and never creates a GPIO command", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const now = Date.now(); await sample(binding, source.id, 42, now, 1);
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id, { trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 } }), "owner", now);
  const execution = await automation.evaluateAutomationRule(binding, rule.id, { mode: "DRY_RUN", expectedRevision: 1, actor: "owner", now });
  assert.equal(execution.status, "DRY_RUN"); assert.equal(execution.matched, true); assert.equal(execution.triggerValue, 42);
  assert.equal(execution.actions[0].status, "DRY_RUN"); assert.equal(execution.actions[0].gpioCommandId, null);
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM gpio_commands WHERE origin = 'AUTOMATION'").first()).count), 0);
  database.close();
});

test("fresh threshold samples persist FOR state, fire once, and rearm only beyond hysteresis", async () => {
  const { database, binding, automation, registry, source, target } = await fixture();
  const t0 = Date.now();
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id), "owner", t0);
  const enabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", rule.revision, "owner", t0);
  await sample(binding, source.id, 36, t0, 1);
  let runs = await automation.evaluateAutomationForDevice(binding, source.id, t0);
  assert.equal(runs[0].status, "ARMED");
  await sample(binding, source.id, 36.5, t0 + 9_999, 2);
  runs = await automation.evaluateAutomationForDevice(binding, source.id, t0 + 9_999);
  assert.equal(runs.length, 0);
  await sample(binding, source.id, 37, t0 + 10_000, 3);
  runs = await automation.evaluateAutomationForDevice(binding, source.id, t0 + 10_000);
  assert.equal(runs[0].status, "ACKNOWLEDGED");
  assert.equal(runs[0].actions[0].status, "ACKNOWLEDGED");
  assert.equal(runs[0].actions[0].targetDeviceId, target.id);
  assert.equal((await registry.getDevicePins(binding, target.id)).find((pin) => pin.pinId === "D7").confirmedValue, 1);
  const command = await binding.prepare("SELECT * FROM gpio_commands WHERE automation_execution_id = ?").bind(runs[0].id).first();
  assert.equal(command.origin, "AUTOMATION"); assert.equal(command.device_id, target.id); assert.equal(command.automation_rule_revision, enabled.rule.revision);
  await sample(binding, source.id, 38, t0 + 20_000, 4);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0 + 20_000)).length, 0);
  await sample(binding, source.id, 33.9, t0 + 21_000, 5);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0 + 21_000))[0].status, "RESET");
  database.close();
});

test("stale samples reset FOR state instead of firing from wall-clock time", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now();
  const draft = thresholdDraft(source.id, target.id, { trigger: { ...thresholdDraft(source.id, target.id).trigger, maxSampleAgeMs: 1_000 } });
  const rule = await automation.createAutomationRule(binding, draft, "owner", t0);
  const enabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", 1, "owner", t0);
  await sample(binding, source.id, 36, t0, 1);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0))[0].status, "ARMED");
  const execution = await automation.evaluateAutomationRule(binding, rule.id, { mode: "DRY_RUN", expectedRevision: enabled.rule.revision, actor: "owner", now: t0 + 10_000 });
  assert.equal(execution.status, "BLOCKED"); assert.match(execution.reason, /stale/i);
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM gpio_commands WHERE origin = 'AUTOMATION'").first()).count), 0);
  database.close();
});

test("a fresh sample after an observation gap restarts FOR and does not rearm a latched rule", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now();
  const draft = thresholdDraft(source.id, target.id, {
    trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0, maxSampleAgeMs: 1_000 },
  });
  const rule = await automation.createAutomationRule(binding, draft, "owner", t0);
  await automation.setAutomationRuleMode(binding, rule.id, "LIVE", 1, "owner", t0);
  await sample(binding, source.id, 36, t0, 1);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0))[0].status, "ACKNOWLEDGED");
  await sample(binding, source.id, 37, t0 + 2_001, 2);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0 + 2_001))[0].status, "BLOCKED");
  await sample(binding, source.id, 38, t0 + 2_500, 3);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0 + 2_500)).length, 0);
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM gpio_commands WHERE origin = 'AUTOMATION'").first()).count), 1);
  await sample(binding, source.id, 33.9, t0 + 2_700, 4);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0 + 2_700))[0].status, "RESET");
  database.close();
});

test("UTC schedule slots are claimed once and missed occurrences are not replayed", async () => {
  const { database, binding, automation, target } = await fixture();
  const t0 = Date.parse("2026-08-28T18:00:00Z");
  const rule = await automation.createAutomationRule(binding, {
    ...thresholdDraft(target.id, target.id),
    name: "Daily output",
    trigger: { kind: "SCHEDULE", scheduleMinuteUtc: 18 * 60 + 1, scheduleDaysMask: 127, scheduleTimezone: "UTC" },
  }, "owner", t0);
  await automation.setAutomationRuleMode(binding, rule.id, "LIVE", 1, "owner", t0);
  assert.equal((await automation.runDueAutomationCycle(binding, t0 + 59_999)).length, 0);
  const first = await automation.runDueAutomationCycle(binding, t0 + 60_000);
  assert.equal(first.length, 1); assert.equal(first[0].status, "ACKNOWLEDGED");
  assert.equal((await automation.runDueAutomationCycle(binding, t0 + 60_000)).length, 0);
  const trigger = (await automation.getAutomationRule(binding, rule.id)).trigger;
  assert.ok(trigger.nextDueAt > t0 + 60_000);
  database.close();
});

test("one due cycle evaluates all 50 bounded rules instead of starving rules after the first 20", async () => {
  const { database, binding, automation, target } = await fixture();
  const t0 = Date.parse("2026-08-28T18:00:00Z");
  for (let index = 0; index < 21; index += 1) {
    const rule = await automation.createAutomationRule(binding, {
      ...thresholdDraft(target.id, target.id), name: `Timed rule ${index}`,
      trigger: { kind: "SCHEDULE", scheduleMinuteUtc: 18 * 60 + 1, scheduleDaysMask: 127, scheduleTimezone: "UTC" },
    }, "owner", t0);
    await automation.setAutomationRuleMode(binding, rule.id, "DRY_RUN", rule.revision, "owner", t0);
  }
  const executions = await automation.runDueAutomationCycle(binding, t0 + 60_000);
  assert.equal(executions.length, 21);
  assert.ok(executions.every((execution) => execution.status === "DRY_RUN"));
  database.close();
});

test("the active-rule cap is enforced atomically across concurrent creates", async () => {
  const { database, binding, automation, source, target } = await fixture();
  await binding.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 49
    ) INSERT INTO automation_rules (id, name, created_by, updated_by)
      SELECT 'FILL-' || value, 'Filler ' || value, 'owner', 'owner' FROM sequence`).run();
  const racing = createInterleavingBinding(binding);
  const results = await Promise.allSettled([
    automation.createAutomationRule(racing, thresholdDraft(source.id, target.id, { name: "Concurrent A" }), "owner"),
    automation.createAutomationRule(racing, thresholdDraft(source.id, target.id, { name: "Concurrent B" }), "owner"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "RULE_LIMIT");
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM automation_rules WHERE archived_at IS NULL").first()).count), 50);
  database.close();
});

test("retention preserves admission-window evidence even when the ledger exceeds 500 rows", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const now = Date.now();
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id, {
    trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 },
    rateLimitCount: 60, rateLimitWindowMs: 60_000,
  }), "owner", now);
  await binding.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 50
    ) INSERT INTO automation_executions
      (id, rule_id, rule_revision, source_kind, source_event_key, execution_mode, status, actor, matched, reason, requested_at, completed_at)
      SELECT 'KEEP-' || value, ?, 1, 'MANUAL', 'keep-' || value, 'LIVE', 'ACKNOWLEDGED', 'owner', 1, 'admission evidence', ?, ?
      FROM sequence`).bind(rule.id, now - 50_000, now - 50_000).run();
  await binding.prepare(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 520
    ) INSERT INTO automation_executions
      (id, rule_id, rule_revision, source_kind, source_event_key, execution_mode, status, actor, matched, reason, requested_at, completed_at)
      SELECT 'NOISE-' || value, ?, 1, 'MANUAL', 'noise-' || value, 'LIVE', 'BLOCKED', 'owner', 0, 'non-admission evidence', ? + value, ? + value
      FROM sequence`).bind(rule.id, now - 20_000, now - 20_000).run();
  await sample(binding, source.id, 42, now, 1);
  await automation.evaluateAutomationRule(binding, rule.id, { mode: "DRY_RUN", expectedRevision: rule.revision, actor: "owner", now });
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM automation_executions WHERE id LIKE 'KEEP-%'").first()).count), 50);
  assert.ok(Number((await binding.prepare("SELECT count(*) AS count FROM automation_executions").first()).count) > 500);
  database.close();
});

test("mode transitions reset threshold FOR state before live execution resumes", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now();
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id), "owner", t0);
  const enabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", rule.revision, "owner", t0);
  await sample(binding, source.id, 36, t0, 1);
  assert.equal((await automation.evaluateAutomationForDevice(binding, source.id, t0))[0].status, "ARMED");

  const disabled = await automation.setAutomationRuleMode(binding, rule.id, "DISABLED", enabled.rule.revision, "owner", t0 + 2_000);
  const reenabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", disabled.rule.revision, "owner", t0 + 5_000);
  assert.equal(reenabled.rule.trigger.conditionSinceAt, null);
  assert.equal(reenabled.rule.trigger.armed, true);

  await sample(binding, source.id, 36, t0 + 10_000, 2);
  const resumed = await automation.evaluateAutomationForDevice(binding, source.id, t0 + 10_000);
  assert.equal(resumed[0].status, "ARMED");
  assert.equal(resumed[0].conditionSinceAt, t0 + 10_000);
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM gpio_commands WHERE origin = 'AUTOMATION'").first()).count), 0);
  database.close();
});

test("schedule and interval rules do not replay occurrences missed while disabled", async () => {
  const { database, binding, automation, target } = await fixture();
  const t0 = Date.parse("2026-08-28T18:00:00Z");
  const schedule = await automation.createAutomationRule(binding, {
    ...thresholdDraft(target.id, target.id), name: "No replay schedule",
    trigger: { kind: "SCHEDULE", scheduleMinuteUtc: 18 * 60 + 1, scheduleDaysMask: 127, scheduleTimezone: "UTC" },
  }, "owner", t0);
  const interval = await automation.createAutomationRule(binding, {
    ...thresholdDraft(target.id, target.id), name: "No replay interval",
    trigger: { kind: "INTERVAL", intervalMs: 10_000 },
  }, "owner", t0);
  const scheduleLive = await automation.setAutomationRuleMode(binding, schedule.id, "LIVE", schedule.revision, "owner", t0);
  const intervalLive = await automation.setAutomationRuleMode(binding, interval.id, "LIVE", interval.revision, "owner", t0);
  const scheduleDisabled = await automation.setAutomationRuleMode(binding, schedule.id, "DISABLED", scheduleLive.rule.revision, "owner", t0 + 5_000);
  const intervalDisabled = await automation.setAutomationRuleMode(binding, interval.id, "DISABLED", intervalLive.rule.revision, "owner", t0 + 5_000);
  const scheduleResumed = await automation.setAutomationRuleMode(binding, schedule.id, "LIVE", scheduleDisabled.rule.revision, "owner", t0 + 120_000);
  const intervalResumed = await automation.setAutomationRuleMode(binding, interval.id, "LIVE", intervalDisabled.rule.revision, "owner", t0 + 120_000);

  assert.equal((await automation.runDueAutomationCycle(binding, t0 + 120_000)).length, 0);
  assert.ok(scheduleResumed.rule.trigger.nextDueAt > t0 + 120_000);
  assert.equal(intervalResumed.rule.trigger.nextDueAt, t0 + 130_000);
  assert.equal((await automation.runDueAutomationCycle(binding, t0 + 129_999)).length, 0);
  const due = await automation.runDueAutomationCycle(binding, t0 + 130_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].ruleId, interval.id);
  assert.equal(due[0].status, "ACKNOWLEDGED");
  database.close();
});

test("competing state mutations with one revision admit exactly one caller", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now();
  const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id), "owner", t0);
  const racing = createInterleavingBinding(binding);
  const results = await Promise.allSettled([
    automation.setAutomationRuleMode(racing, rule.id, "LIVE", rule.revision, "first@example.com", t0),
    automation.setAutomationRuleMode(racing, rule.id, "DRY_RUN", rule.revision, "second@example.com", t0),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "REVISION_CONFLICT");
  const current = await automation.getAutomationRule(binding, rule.id);
  assert.equal(current.revision, rule.revision + 1);
  assert.ok(["LIVE", "DRY_RUN"].includes(current.mode));
  database.close();
});

test("manual live evaluation preserves the authenticated human actor", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now();
  const draft = thresholdDraft(source.id, target.id, {
    trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 },
  });
  const rule = await automation.createAutomationRule(binding, draft, "owner", t0);
  const enabled = await automation.setAutomationRuleMode(binding, rule.id, "LIVE", rule.revision, "owner", t0);
  await sample(binding, source.id, 42, t0, 1);
  const execution = await automation.evaluateAutomationRule(binding, rule.id, {
    mode: "MANUAL", expectedRevision: enabled.rule.revision, confirmHardware: true,
    actor: "operator@example.com", now: t0,
  });
  assert.equal(execution.status, "ACKNOWLEDGED");
  assert.equal(execution.sourceKind, "MANUAL");
  assert.equal(execution.actor, "operator@example.com");
  const command = await binding.prepare("SELECT actor FROM gpio_commands WHERE automation_execution_id = ?").bind(execution.id).first();
  assert.equal(command.actor, `automation:${rule.id}`);
  database.close();
});

test("device lock and disarm cancel queued physical automation consistently", async () => {
  const dbModule = await vite.ssrLoadModule("/db/index.ts");
  const deviceRoute = await vite.ssrLoadModule("/app/api/devices/[id]/route.ts");
  for (const mutation of [{ monitorOnly: true }, { automationArmed: false }]) {
    const context = await fixture(); const t0 = Date.now();
    dbModule.setDatabase(context.binding);
    const { execution } = await queuePhysicalAutomation(context, t0);
    const response = await deviceRoute.PATCH(new Request(`https://switchboard.test/api/devices/${context.target.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation),
    }), { params: Promise.resolve({ id: context.target.id }) });
    assert.equal(response.status, 200);
    const command = await context.binding.prepare("SELECT status FROM gpio_commands WHERE automation_execution_id = ?").bind(execution.id).first();
    const action = await context.binding.prepare("SELECT status FROM automation_action_runs WHERE execution_id = ?").bind(execution.id).first();
    const run = await context.binding.prepare("SELECT status FROM automation_executions WHERE id = ?").bind(execution.id).first();
    assert.equal(command.status, "FAILED");
    assert.equal(action.status, "CANCELLED");
    assert.equal(run.status, "CANCELLED");
    context.database.close();
  }
});

test("device permission and locks block live automation and cancel queued work", async () => {
  const { database, binding, automation, source, target } = await fixture();
  const t0 = Date.now(); const rule = await automation.createAutomationRule(binding, thresholdDraft(source.id, target.id, { trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 } }), "owner", t0);
  await binding.prepare("UPDATE devices SET automation_armed = 0 WHERE id = ?").bind(target.id).run();
  await assert.rejects(automation.setAutomationRuleMode(binding, rule.id, "LIVE", 1, "owner", t0), /not armed/);
  await binding.prepare("UPDATE devices SET automation_armed = 1, monitor_only = 1 WHERE id = ?").bind(target.id).run();
  await assert.rejects(automation.setAutomationRuleMode(binding, rule.id, "LIVE", 1, "owner", t0), /Monitor Only/);
  database.close();
});

test("automation APIs ignore client actors, require revisions, and expose the dedicated workbench", async () => {
  const { database, binding, source, target } = await fixture();
  const dbModule = await vite.ssrLoadModule("/db/index.ts"); dbModule.setDatabase(binding);
  const route = await vite.ssrLoadModule("/app/api/automations/route.ts");
  let response = await route.POST(new Request("https://switchboard.test/api/automations", {
    method: "POST", headers: { "content-type": "application/json", "x-switchboard-authenticated-user-email": "operator@example.com" },
    body: JSON.stringify({ ...thresholdDraft(source.id, target.id), actor: "spoofed" }),
  }));
  assert.equal(response.status, 422);
  response = await route.POST(new Request("https://switchboard.test/api/automations", {
    method: "POST", headers: { "content-type": "application/json", "x-switchboard-authenticated-user-email": "operator@example.com" },
    body: JSON.stringify(thresholdDraft(source.id, target.id, { trigger: { ...thresholdDraft(source.id, target.id).trigger, holdForMs: 0 } })),
  }));
  assert.equal(response.status, 201); const created = (await response.json()).rule;
  assert.equal(created.createdBy, "operator@example.com"); assert.equal(created.mode, "DISABLED");
  const stateRoute = await vite.ssrLoadModule("/app/api/automations/[id]/state/route.ts");
  response = await stateRoute.POST(new Request(`https://switchboard.test/api/automations/${created.id}/state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "LIVE", expectedRevision: 1 }),
  }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(response.status, 200);
  await sample(binding, source.id, 42, Date.now(), 1);
  const evaluateRoute = await vite.ssrLoadModule("/app/api/automations/[id]/evaluate/route.ts");
  response = await evaluateRoute.POST(new Request(`https://switchboard.test/api/automations/${created.id}/evaluate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "LIVE", expectedRevision: 1 }),
  }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(response.status, 400);
  assert.equal(Number((await binding.prepare("SELECT count(*) AS count FROM gpio_commands WHERE origin = 'AUTOMATION'").first()).count), 0);
  const ui = await readFile(new URL("../app/automation-workbench.tsx", import.meta.url), "utf8").catch(() => "");
  assert.match(ui, /WHEN/); assert.match(ui, /FOR/); assert.match(ui, /THEN/); assert.match(ui, /DRY RUN/); assert.match(ui, /Execution history/);
  database.close();
});

test("automation mutation routes reject malformed revisions without cacheable errors", async () => {
  const { database, binding } = await fixture();
  const dbModule = await vite.ssrLoadModule("/db/index.ts"); dbModule.setDatabase(binding);
  const itemRoute = await vite.ssrLoadModule("/app/api/automations/[id]/route.ts");
  const stateRoute = await vite.ssrLoadModule("/app/api/automations/[id]/state/route.ts");
  const evaluateRoute = await vite.ssrLoadModule("/app/api/automations/[id]/evaluate/route.ts");
  const context = { params: Promise.resolve({ id: "AUTO-NOT-USED" }) };
  const assertPrivate400 = (response) => {
    assert.equal(response.status, 400);
    assert.match(response.headers.get("cache-control") ?? "", /private/i);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  };
  for (const suffix of ["", "?expectedRevision=", "?expectedRevision=0", "?expectedRevision=01", "?expectedRevision=9007199254740992"]) {
    assertPrivate400(await itemRoute.DELETE(new Request(`https://switchboard.test/api/automations/AUTO-NOT-USED${suffix}`, { method: "DELETE" }), context));
  }
  assertPrivate400(await itemRoute.PATCH(new Request("https://switchboard.test/api/automations/AUTO-NOT-USED", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, rule: {} }),
  }), context));
  assertPrivate400(await stateRoute.POST(new Request("https://switchboard.test/api/automations/AUTO-NOT-USED/state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "LIVE", expectedRevision: 0 }),
  }), context));
  assertPrivate400(await evaluateRoute.POST(new Request("https://switchboard.test/api/automations/AUTO-NOT-USED/evaluate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "DRY_RUN", expectedRevision: 0 }),
  }), context));
  database.close();
});
