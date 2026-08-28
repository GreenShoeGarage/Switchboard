import type { DatabaseBinding } from "@/db";
import {
  AUTOMATION_EXECUTION_RETENTION,
  AUTOMATION_MAX_ACTIONS,
  AUTOMATION_MIN_LIVE_COOLDOWN_MS,
  type AutomationActionRecord,
  type AutomationActionRunRecord,
  type AutomationActionScope,
  type AutomationComparator,
  type AutomationExecutionRecord,
  type AutomationExecutionStatus,
  type AutomationRuleDraft,
  type AutomationRuleMode,
  type AutomationRuleRecord,
  type AutomationTriggerKind,
  type AutomationTriggerRecord,
} from "@/lib/device-model";
import { executeServerSimulatorCommand, expireGpioCommands, issueGpioCommand } from "@/lib/gpio-server";
import { getDevice, getDevicePins } from "@/lib/registry-server";

type Row = Record<string, unknown>;
export type AutomationIssue = {
  path: string;
  code: string;
  message: string;
  severity: "ERROR" | "WARNING";
};

type NormalizedDraft = Required<Pick<AutomationRuleDraft,
  "name" | "description" | "actionScope" | "cooldownMs" | "rateLimitCount" | "rateLimitWindowMs" | "maxChainDepth">> & {
    trigger: {
      kind: AutomationTriggerKind;
      sourceDeviceId: string | null;
      sourcePinId: string | null;
      comparator: AutomationComparator | null;
      thresholdValue: number | null;
      hysteresis: number;
      holdForMs: number;
      maxSampleAgeMs: number;
      sourceUnit: string | null;
      sourceConfigurationVersion: number | null;
      intervalMs: number | null;
      scheduleMinuteUtc: number | null;
      scheduleDaysMask: number | null;
      scheduleTimezone: "UTC";
    };
    actions: Array<{
      targetDeviceId: string;
      targetPinId: string;
      commandKind: AutomationActionRecord["commandKind"];
      requestedValue: number;
      targetConfigurationVersion: number;
    }>;
  };

type EvaluationContext = {
  now: number;
  actor: string;
  preview?: boolean;
  confirmHardware?: boolean;
  rootExecutionId?: string | null;
  parentExecutionId?: string | null;
  chainDepth?: number;
  sourceKindOverride?: "MANUAL";
};

export class AutomationError extends Error {
  code: string;
  status: number;
  issues: AutomationIssue[];
  retryAfterMs?: number;

  constructor(message: string, code: string, status = 400, issues: AutomationIssue[] = [], retryAfterMs?: number) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.status = status;
    this.issues = issues;
    this.retryAfterMs = retryAfterMs;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function stringOrNull(value: unknown) { return typeof value === "string" ? value : null; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }
function booleanValue(value: unknown) { return value === true || value === 1; }
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: AutomationIssue[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, code: "UNKNOWN_FIELD", message: "Unsupported or protected field", severity: "ERROR" });
  }
}

function mapTrigger(row: Row): AutomationTriggerRecord {
  return {
    id: text(row.id), ruleId: text(row.rule_id), kind: text(row.kind) as AutomationTriggerKind,
    sourceDeviceId: stringOrNull(row.source_device_id), sourcePinId: stringOrNull(row.source_pin_id),
    comparator: stringOrNull(row.comparator) as AutomationComparator | null,
    thresholdValue: numberOrNull(row.threshold_value), hysteresis: Number(row.hysteresis),
    holdForMs: Number(row.hold_for_ms), maxSampleAgeMs: Number(row.max_sample_age_ms),
    sourceUnit: stringOrNull(row.source_unit), sourceConfigurationVersion: numberOrNull(row.source_configuration_version),
    intervalMs: numberOrNull(row.interval_ms), scheduleMinuteUtc: numberOrNull(row.schedule_minute_utc),
    scheduleDaysMask: numberOrNull(row.schedule_days_mask), scheduleTimezone: "UTC",
    lastSourceEventKey: stringOrNull(row.last_source_event_key), lastObservedValue: numberOrNull(row.last_observed_value),
    conditionSinceAt: numberOrNull(row.condition_since_at), armed: booleanValue(row.armed),
    nextDueAt: numberOrNull(row.next_due_at), lastEvaluatedAt: numberOrNull(row.last_evaluated_at),
    lastFiredAt: numberOrNull(row.last_fired_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function mapAction(row: Row): AutomationActionRecord {
  return {
    id: text(row.id), ruleId: text(row.rule_id), position: Number(row.position),
    targetDeviceId: stringOrNull(row.target_device_id), targetPinId: text(row.target_pin_id),
    commandKind: text(row.command_kind) as AutomationActionRecord["commandKind"],
    requestedValue: Number(row.requested_value), targetConfigurationVersion: numberOrNull(row.target_configuration_version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function mapRule(row: Row, trigger: AutomationTriggerRecord, actions: AutomationActionRecord[], suspensionReasons: string[] = []): AutomationRuleRecord {
  return {
    id: text(row.id), name: text(row.name), description: text(row.description),
    mode: text(row.mode) as AutomationRuleMode, revision: Number(row.revision), permissionScope: "OWNER_ONLY",
    actionScope: text(row.action_scope) as AutomationActionScope,
    approvedRevision: numberOrNull(row.approved_revision), approvedBy: stringOrNull(row.approved_by), approvedAt: numberOrNull(row.approved_at),
    cooldownMs: Number(row.cooldown_ms), rateLimitCount: Number(row.rate_limit_count), rateLimitWindowMs: Number(row.rate_limit_window_ms),
    maxChainDepth: Number(row.max_chain_depth), createdBy: text(row.created_by), updatedBy: text(row.updated_by),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), archivedAt: numberOrNull(row.archived_at),
    trigger, actions, suspensionReasons,
  };
}

function mapActionRun(row: Row): AutomationActionRunRecord {
  return {
    id: text(row.id), executionId: text(row.execution_id), actionId: stringOrNull(row.action_id), position: Number(row.position),
    targetDeviceId: text(row.target_device_id), targetPinId: text(row.target_pin_id),
    commandKind: text(row.command_kind) as AutomationActionRecord["commandKind"], requestedValue: Number(row.requested_value),
    status: text(row.status) as AutomationActionRunRecord["status"], gpioCommandId: stringOrNull(row.gpio_command_id),
    error: text(row.error), startedAt: numberOrNull(row.started_at), completedAt: numberOrNull(row.completed_at),
  };
}

function mapExecution(row: Row, actions: AutomationActionRunRecord[]): AutomationExecutionRecord {
  return {
    id: text(row.id), ruleId: text(row.rule_id), ruleName: text(row.rule_name), triggerId: stringOrNull(row.trigger_id),
    ruleRevision: Number(row.rule_revision), sourceKind: text(row.source_kind) as AutomationExecutionRecord["sourceKind"],
    sourceEventKey: text(row.source_event_key), executionMode: text(row.execution_mode) as AutomationExecutionRecord["executionMode"],
    status: text(row.status) as AutomationExecutionStatus, actor: text(row.actor),
    rootExecutionId: stringOrNull(row.root_execution_id), parentExecutionId: stringOrNull(row.parent_execution_id), chainDepth: Number(row.chain_depth),
    triggerValue: numberOrNull(row.trigger_value), triggerRecordedAt: numberOrNull(row.trigger_recorded_at),
    conditionSinceAt: numberOrNull(row.condition_since_at), matched: booleanValue(row.matched), reason: text(row.reason),
    requestedAt: Number(row.requested_at), startedAt: numberOrNull(row.started_at), completedAt: numberOrNull(row.completed_at), actions,
  };
}

function actor(value: string) { return value.trim().slice(0, 120) || "owner"; }
function id(prefix: string) { return `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`; }

export function thresholdMatches(comparator: AutomationComparator, value: number, threshold: number) {
  if (comparator === "GT") return value > threshold;
  if (comparator === "GTE") return value >= threshold;
  if (comparator === "LT") return value < threshold;
  if (comparator === "LTE") return value <= threshold;
  if (comparator === "EQ") return value === threshold;
  return value !== threshold;
}

export function thresholdHasReset(comparator: AutomationComparator, value: number, threshold: number, hysteresis: number) {
  if (comparator === "GT") return value <= threshold - hysteresis;
  if (comparator === "GTE") return value < threshold - hysteresis;
  if (comparator === "LT") return value >= threshold + hysteresis;
  if (comparator === "LTE") return value > threshold + hysteresis;
  if (comparator === "EQ") return Math.abs(value - threshold) > hysteresis;
  return Math.abs(value - threshold) <= hysteresis;
}

export function nextScheduleOccurrence(now: number, minuteUtc: number, daysMask: number) {
  const base = new Date(now);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset, Math.floor(minuteUtc / 60), minuteUtc % 60, 0, 0));
    if (candidate.getTime() <= now) continue;
    if ((daysMask & (1 << candidate.getUTCDay())) !== 0) return candidate.getTime();
  }
  throw new Error("Schedule has no enabled day");
}

async function actionRuns(db: DatabaseBinding, executionId: string) {
  const result = await db.prepare(`SELECT * FROM automation_action_runs WHERE execution_id = ? ORDER BY position`).bind(executionId).all<Row>();
  return (result.results ?? []).map(mapActionRun);
}

export async function getAutomationExecution(db: DatabaseBinding, executionId: string) {
  const row = await db.prepare(`SELECT execution.*, rule.name AS rule_name FROM automation_executions execution
    JOIN automation_rules rule ON rule.id = execution.rule_id WHERE execution.id = ?`).bind(executionId).first<Row>();
  return row ? mapExecution(row, await actionRuns(db, executionId)) : null;
}

async function suspensionReasons(db: DatabaseBinding, rule: AutomationRuleRecord) {
  const reasons: string[] = [];
  if (rule.mode === "LIVE" && rule.approvedRevision !== rule.revision) reasons.push("Rule revision is not approved for live execution");
  if (rule.trigger.kind === "THRESHOLD") {
    if (!rule.trigger.sourceDeviceId || !rule.trigger.sourcePinId) reasons.push("Source device or pin no longer exists");
    else {
      const source = await getDevice(db, rule.trigger.sourceDeviceId);
      const sourcePin = (await getDevicePins(db, rule.trigger.sourceDeviceId)).find((pin) => pin.pinId === rule.trigger.sourcePinId);
      if (!source || !sourcePin) reasons.push("Source device or pin no longer exists");
      else {
        if (source.connectionState !== "ONLINE") reasons.push("Source device is offline");
        if (!source.simulated && !source.controlReady) reasons.push("Source device has no accepted current-session snapshot");
        if (!source.simulated && !await physicalHilPassed(db, source.id)) reasons.push("Physical automation source requires a current passing Hardware-in-the-Loop record");
        const unit = sourcePin.mode === "ANALOG" ? sourcePin.engineeringUnit ?? "V" : null;
        if (unit !== rule.trigger.sourceUnit || source.configurationVersion !== rule.trigger.sourceConfigurationVersion) reasons.push("Source calibration or configuration changed");
      }
    }
  }
  for (const action of rule.actions) {
    if (!action.targetDeviceId) { reasons.push(`Target for action ${action.position + 1} no longer exists`); continue; }
    const target = await getDevice(db, action.targetDeviceId);
    const targetPin = (await getDevicePins(db, action.targetDeviceId)).find((pin) => pin.pinId === action.targetPinId);
    if (!target || !targetPin) { reasons.push(`Target for action ${action.position + 1} no longer exists`); continue; }
    if (!target.automationArmed) reasons.push(`${target.name} is not armed for automation`);
    if (target.connectionState !== "ONLINE") reasons.push(`${target.name} is offline`);
    if (!target.simulated && !target.controlReady) reasons.push(`${target.name} has no accepted current-session snapshot`);
    if (target.maintenanceMode) reasons.push(`${target.name} is in Maintenance Mode`);
    if (target.monitorOnly) reasons.push(`${target.name} is Monitor Only`);
    if (target.configurationVersion !== action.targetConfigurationVersion) reasons.push(`${target.name} configuration changed`);
    if (!target.simulated && rule.actionScope !== "PHYSICAL_CONTROL") reasons.push("Rule is scoped to simulators only");
    if (!target.simulated && !await physicalHilPassed(db, target.id)) reasons.push("Physical automation requires a passing Hardware-in-the-Loop record");
  }
  return [...new Set(reasons)];
}

export async function getAutomationRule(db: DatabaseBinding, ruleId: string, includeArchived = false) {
  const row = await db.prepare(`SELECT * FROM automation_rules WHERE id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`).bind(ruleId).first<Row>();
  if (!row) return null;
  const triggerRow = await db.prepare("SELECT * FROM automation_triggers WHERE rule_id = ?").bind(ruleId).first<Row>();
  const actionRows = await db.prepare("SELECT * FROM automation_actions WHERE rule_id = ? ORDER BY position").bind(ruleId).all<Row>();
  if (!triggerRow) return null;
  const mapped = mapRule(row, mapTrigger(triggerRow), (actionRows.results ?? []).map(mapAction));
  return { ...mapped, suspensionReasons: await suspensionReasons(db, mapped) };
}

export async function listAutomationRules(db: DatabaseBinding, limit = 50) {
  const bounded = Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.round(limit) : 50));
  const rows = await db.prepare(`SELECT id FROM automation_rules WHERE archived_at IS NULL ORDER BY updated_at DESC, id LIMIT ?`).bind(bounded).all<Row>();
  const rules: AutomationRuleRecord[] = [];
  for (const row of rows.results ?? []) {
    const rule = await getAutomationRule(db, text(row.id));
    if (rule) rules.push(rule);
  }
  return rules;
}

function valueIssue(issues: AutomationIssue[], path: string, code: string, message: string) {
  issues.push({ path, code, message, severity: "ERROR" });
}

export async function validateAutomationDraft(db: DatabaseBinding, input: unknown) {
  const issues: AutomationIssue[] = [];
  if (!isObject(input)) return { valid: false, issues: [{ path: "", code: "INVALID_BODY", message: "Rule must be an object", severity: "ERROR" as const }], normalized: null };
  unknownKeys(input, ["name", "description", "actionScope", "trigger", "actions", "cooldownMs", "rateLimitCount", "rateLimitWindowMs", "maxChainDepth"], "", issues);
  const rawName = input.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) valueIssue(issues, "name", "NAME_REQUIRED", "Rule name is required");
  if (typeof rawName === "string" && rawName.length > 80) valueIssue(issues, "name", "NAME_TOO_LONG", "Rule name must be at most 80 characters");
  const rawDescription = input.description;
  const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
  if (rawDescription !== undefined && typeof rawDescription !== "string") valueIssue(issues, "description", "DESCRIPTION_INVALID", "Description must be text");
  if (typeof rawDescription === "string" && rawDescription.length > 500) valueIssue(issues, "description", "DESCRIPTION_TOO_LONG", "Description must be at most 500 characters");
  const actionScope: AutomationActionScope = input.actionScope === "PHYSICAL_CONTROL" ? "PHYSICAL_CONTROL" : "SIMULATOR_ONLY";
  if (input.actionScope !== undefined && input.actionScope !== "SIMULATOR_ONLY" && input.actionScope !== "PHYSICAL_CONTROL") valueIssue(issues, "actionScope", "SCOPE_INVALID", "Action scope must be SIMULATOR_ONLY or PHYSICAL_CONTROL");
  const cooldownMs = boundedInteger(input.cooldownMs, 60_000, 0, 86_400_000);
  if (input.cooldownMs !== undefined && cooldownMs !== input.cooldownMs) valueIssue(issues, "cooldownMs", "COOLDOWN_INVALID", "Cooldown must be a whole number from 0 through 86,400,000 milliseconds");
  const rateLimitCount = boundedInteger(input.rateLimitCount, 10, 1, 60);
  if (input.rateLimitCount !== undefined && rateLimitCount !== input.rateLimitCount) valueIssue(issues, "rateLimitCount", "RATE_COUNT_INVALID", "Rate limit must allow 1 through 60 executions per window");
  const rateLimitWindowMs = boundedInteger(input.rateLimitWindowMs, 3_600_000, 60_000, 86_400_000);
  if (input.rateLimitWindowMs !== undefined && rateLimitWindowMs !== input.rateLimitWindowMs) valueIssue(issues, "rateLimitWindowMs", "RATE_WINDOW_INVALID", "Rate window must be 60,000 through 86,400,000 milliseconds");
  const maxChainDepth = boundedInteger(input.maxChainDepth, 2, 0, 4);
  if (input.maxChainDepth !== undefined && maxChainDepth !== input.maxChainDepth) valueIssue(issues, "maxChainDepth", "CHAIN_DEPTH_INVALID", "Chain depth must be a whole number from 0 through 4");

  const triggerInput = isObject(input.trigger) ? input.trigger : {};
  if (!isObject(input.trigger)) valueIssue(issues, "trigger", "TRIGGER_REQUIRED", "One structured trigger is required");
  const kind = text(triggerInput.kind) as AutomationTriggerKind;
  if (!["THRESHOLD", "INTERVAL", "SCHEDULE"].includes(kind)) valueIssue(issues, "trigger.kind", "TRIGGER_KIND_INVALID", "Trigger kind must be THRESHOLD, INTERVAL, or SCHEDULE");
  if (kind === "THRESHOLD") unknownKeys(triggerInput, ["kind", "sourceDeviceId", "sourcePinId", "comparator", "thresholdValue", "hysteresis", "holdForMs", "maxSampleAgeMs"], "trigger", issues);
  if (kind === "INTERVAL") unknownKeys(triggerInput, ["kind", "intervalMs"], "trigger", issues);
  if (kind === "SCHEDULE") unknownKeys(triggerInput, ["kind", "scheduleMinuteUtc", "scheduleDaysMask", "scheduleTimezone"], "trigger", issues);
  let sourceDeviceId: string | null = null;
  let sourcePinId: string | null = null;
  let comparator: AutomationComparator | null = null;
  let thresholdValue: number | null = null;
  let sourceUnit: string | null = null;
  let sourceConfigurationVersion: number | null = null;
  const hysteresis = typeof triggerInput.hysteresis === "number" && Number.isFinite(triggerInput.hysteresis) && triggerInput.hysteresis >= 0 ? triggerInput.hysteresis : 0;
  if (triggerInput.hysteresis !== undefined && hysteresis !== triggerInput.hysteresis) valueIssue(issues, "trigger.hysteresis", "HYSTERESIS_INVALID", "Hysteresis must be a finite number at or above zero");
  const holdForMs = boundedInteger(triggerInput.holdForMs, 0, 0, 86_400_000);
  if (triggerInput.holdForMs !== undefined && holdForMs !== triggerInput.holdForMs) valueIssue(issues, "trigger.holdForMs", "HOLD_INVALID", "FOR duration must be a whole number from 0 through 86,400,000 milliseconds");
  const maxSampleAgeMs = boundedInteger(triggerInput.maxSampleAgeMs, 30_000, 1_000, 300_000);
  if (triggerInput.maxSampleAgeMs !== undefined && maxSampleAgeMs !== triggerInput.maxSampleAgeMs) valueIssue(issues, "trigger.maxSampleAgeMs", "SAMPLE_AGE_INVALID", "Maximum sample age must be 1,000 through 300,000 milliseconds");
  let intervalMs: number | null = null;
  let scheduleMinuteUtc: number | null = null;
  let scheduleDaysMask: number | null = null;
  if (kind === "THRESHOLD") {
    const rawSourceDeviceId = triggerInput.sourceDeviceId;
    const rawSourcePinId = triggerInput.sourcePinId;
    sourceDeviceId = typeof rawSourceDeviceId === "string" ? rawSourceDeviceId.trim() || null : null;
    sourcePinId = typeof rawSourcePinId === "string" ? rawSourcePinId.trim() || null : null;
    if (typeof rawSourceDeviceId === "string" && rawSourceDeviceId.length > 80) valueIssue(issues, "trigger.sourceDeviceId", "SOURCE_DEVICE_TOO_LONG", "Source device ID must be at most 80 characters");
    if (typeof rawSourcePinId === "string" && rawSourcePinId.length > 8) valueIssue(issues, "trigger.sourcePinId", "SOURCE_PIN_TOO_LONG", "Source pin ID must be at most 8 characters");
    comparator = text(triggerInput.comparator) as AutomationComparator;
    thresholdValue = typeof triggerInput.thresholdValue === "number" && Number.isFinite(triggerInput.thresholdValue) ? triggerInput.thresholdValue : null;
    if (!sourceDeviceId) valueIssue(issues, "trigger.sourceDeviceId", "SOURCE_DEVICE_REQUIRED", "Threshold source device is required");
    if (!sourcePinId) valueIssue(issues, "trigger.sourcePinId", "SOURCE_PIN_REQUIRED", "Threshold source pin is required");
    if (!comparator || !["GT", "GTE", "LT", "LTE", "EQ", "NE"].includes(comparator)) valueIssue(issues, "trigger.comparator", "COMPARATOR_INVALID", "Comparator is invalid");
    if (thresholdValue === null) valueIssue(issues, "trigger.thresholdValue", "THRESHOLD_INVALID", "Threshold must be a finite number");
    if (sourceDeviceId && sourcePinId) {
      const source = await getDevice(db, sourceDeviceId);
      const pin = (await getDevicePins(db, sourceDeviceId)).find((candidate) => candidate.pinId === sourcePinId);
      if (!source || !pin) valueIssue(issues, "trigger.sourcePinId", "SOURCE_NOT_FOUND", "Source device and pin must exist");
      else {
        sourceUnit = pin.mode === "ANALOG" ? pin.engineeringUnit ?? "V" : null;
        sourceConfigurationVersion = source.configurationVersion;
      }
    }
  } else if (kind === "INTERVAL") {
    intervalMs = boundedInteger(triggerInput.intervalMs, 60_000, 10_000, 604_800_000);
    if (triggerInput.intervalMs === undefined || intervalMs !== triggerInput.intervalMs) valueIssue(issues, "trigger.intervalMs", "INTERVAL_INVALID", "Interval must be a whole number from 10 seconds through 7 days");
  } else if (kind === "SCHEDULE") {
    scheduleMinuteUtc = boundedInteger(triggerInput.scheduleMinuteUtc, -1, 0, 1439);
    scheduleDaysMask = boundedInteger(triggerInput.scheduleDaysMask, -1, 1, 127);
    if (scheduleMinuteUtc < 0) valueIssue(issues, "trigger.scheduleMinuteUtc", "SCHEDULE_TIME_INVALID", "Schedule minute must be 0 through 1439 UTC");
    if (scheduleDaysMask < 1) valueIssue(issues, "trigger.scheduleDaysMask", "SCHEDULE_DAYS_INVALID", "At least one UTC schedule day is required");
    if (triggerInput.scheduleTimezone !== undefined && triggerInput.scheduleTimezone !== "UTC") valueIssue(issues, "trigger.scheduleTimezone", "TIMEZONE_INVALID", "Batch 8 schedules use UTC only");
  }

  const actionInputs = Array.isArray(input.actions) ? input.actions : [];
  if (actionInputs.length !== AUTOMATION_MAX_ACTIONS) valueIssue(issues, "actions", "ACTION_COUNT_INVALID", `Batch 8 requires exactly ${AUTOMATION_MAX_ACTIONS} bounded output action per rule`);
  const actions: NormalizedDraft["actions"] = [];
  for (const [position, raw] of actionInputs.slice(0, AUTOMATION_MAX_ACTIONS).entries()) {
    const actionInput = isObject(raw) ? raw : {};
    if (!isObject(raw)) valueIssue(issues, `actions[${position}]`, "ACTION_INVALID", "Action must be an object");
    unknownKeys(actionInput, ["targetDeviceId", "targetPinId", "commandKind", "requestedValue"], `actions[${position}]`, issues);
    const rawTargetDeviceId = actionInput.targetDeviceId;
    const rawTargetPinId = actionInput.targetPinId;
    const targetDeviceId = typeof rawTargetDeviceId === "string" ? rawTargetDeviceId.trim() : "";
    const targetPinId = typeof rawTargetPinId === "string" ? rawTargetPinId.trim() : "";
    if (typeof rawTargetDeviceId === "string" && rawTargetDeviceId.length > 80) valueIssue(issues, `actions[${position}].targetDeviceId`, "TARGET_DEVICE_TOO_LONG", "Target device ID must be at most 80 characters");
    if (typeof rawTargetPinId === "string" && rawTargetPinId.length > 8) valueIssue(issues, `actions[${position}].targetPinId`, "TARGET_PIN_TOO_LONG", "Target pin ID must be at most 8 characters");
    const commandKind = text(actionInput.commandKind) as AutomationActionRecord["commandKind"];
    const requestedValue = typeof actionInput.requestedValue === "number" && Number.isFinite(actionInput.requestedValue) ? actionInput.requestedValue : Number.NaN;
    if (!targetDeviceId) valueIssue(issues, `actions[${position}].targetDeviceId`, "TARGET_DEVICE_REQUIRED", "Target device is required");
    if (!targetPinId) valueIssue(issues, `actions[${position}].targetPinId`, "TARGET_PIN_REQUIRED", "Target pin is required");
    if (!["WRITE", "WRITE_PWM", "WRITE_DAC"].includes(commandKind)) valueIssue(issues, `actions[${position}].commandKind`, "ACTION_KIND_INVALID", "Automation can only issue absolute WRITE, WRITE_PWM, or WRITE_DAC actions");
    if (!Number.isFinite(requestedValue)) valueIssue(issues, `actions[${position}].requestedValue`, "ACTION_VALUE_INVALID", "Action value must be finite");
    const target = targetDeviceId ? await getDevice(db, targetDeviceId) : null;
    const pin = targetDeviceId ? (await getDevicePins(db, targetDeviceId)).find((candidate) => candidate.pinId === targetPinId) : null;
    if (!target || !pin) valueIssue(issues, `actions[${position}].targetPinId`, "TARGET_NOT_FOUND", "Target device and pin must exist");
    else {
      const expectedKind = pin.mode === "OUTPUT" ? "WRITE" : pin.mode === "PWM" ? "WRITE_PWM" : pin.mode === "DAC" ? "WRITE_DAC" : null;
      if (commandKind !== expectedKind) valueIssue(issues, `actions[${position}].commandKind`, "PIN_MODE_MISMATCH", `${targetPinId} is not configured for ${commandKind || "this action"}`);
      if (commandKind === "WRITE" && requestedValue !== 0 && requestedValue !== 1) valueIssue(issues, `actions[${position}].requestedValue`, "DIGITAL_VALUE_INVALID", "Digital action value must be 0 or 1");
      if ((commandKind === "WRITE_PWM" || commandKind === "WRITE_DAC") && (!Number.isInteger(requestedValue) || requestedValue < 0 || requestedValue > 4095)) valueIssue(issues, `actions[${position}].requestedValue`, "MODULATED_VALUE_INVALID", "PWM and DAC actions require a 12-bit integer from 0 through 4095");
      if (kind === "THRESHOLD" && sourceDeviceId === targetDeviceId && sourcePinId === targetPinId) valueIssue(issues, `actions[${position}]`, "DIRECT_LOOP", "A rule cannot write directly to its own source pin");
      actions.push({ targetDeviceId, targetPinId, commandKind, requestedValue, targetConfigurationVersion: target.configurationVersion });
    }
  }

  const normalized: NormalizedDraft | null = issues.some((issue) => issue.severity === "ERROR") ? null : {
    name, description, actionScope, cooldownMs, rateLimitCount, rateLimitWindowMs, maxChainDepth,
    trigger: { kind, sourceDeviceId, sourcePinId, comparator, thresholdValue, hysteresis, holdForMs, maxSampleAgeMs, sourceUnit, sourceConfigurationVersion, intervalMs, scheduleMinuteUtc, scheduleDaysMask, scheduleTimezone: "UTC" },
    actions,
  };
  return { valid: Boolean(normalized), issues, normalized };
}

function throwInvalid(issues: AutomationIssue[]): never {
  throw new AutomationError("Rule validation failed", "AUTOMATION_INVALID", 422, issues);
}

function initialNextDue(trigger: NormalizedDraft["trigger"], now: number) {
  if (trigger.kind === "INTERVAL") return now + (trigger.intervalMs ?? 60_000);
  if (trigger.kind === "SCHEDULE") return nextScheduleOccurrence(now, trigger.scheduleMinuteUtc!, trigger.scheduleDaysMask!);
  return null;
}

export async function createAutomationRule(db: DatabaseBinding, input: unknown, createdBy: string, now = Date.now()) {
  const validation = await validateAutomationDraft(db, input);
  if (!validation.normalized) throwInvalid(validation.issues);
  const draft = validation.normalized;
  const ruleId = id("AUTO"); const triggerId = id("TRG"); const actionId = id("ACT"); const mutationId = id("MUT"); const owner = actor(createdBy);
  await db.batch([
    db.prepare(`INSERT INTO automation_rules
      (id, name, description, mode, revision, mutation_id, permission_scope, action_scope, cooldown_ms, rate_limit_count,
        rate_limit_window_ms, max_chain_depth, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, 'DISABLED', 1, ?, 'OWNER_ONLY', ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM automation_rules WHERE archived_at IS NULL) < 50`)
      .bind(ruleId, draft.name, draft.description, mutationId, draft.actionScope, draft.cooldownMs, draft.rateLimitCount, draft.rateLimitWindowMs, draft.maxChainDepth, owner, owner, now, now),
    db.prepare(`INSERT INTO automation_triggers
      (id, rule_id, kind, source_device_id, source_pin_id, comparator, threshold_value, hysteresis, hold_for_ms,
        max_sample_age_ms, source_unit, source_configuration_version, interval_ms, schedule_minute_utc,
        schedule_days_mask, schedule_timezone, armed, next_due_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UTC', 1, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM automation_rules WHERE id = ? AND mutation_id = ?)`)
      .bind(triggerId, ruleId, draft.trigger.kind, draft.trigger.sourceDeviceId, draft.trigger.sourcePinId, draft.trigger.comparator,
        draft.trigger.thresholdValue, draft.trigger.hysteresis, draft.trigger.holdForMs, draft.trigger.maxSampleAgeMs,
        draft.trigger.sourceUnit, draft.trigger.sourceConfigurationVersion, draft.trigger.intervalMs,
        draft.trigger.scheduleMinuteUtc, draft.trigger.scheduleDaysMask, initialNextDue(draft.trigger, now), now, now, ruleId, mutationId),
    db.prepare(`INSERT INTO automation_actions
      (id, rule_id, position, target_device_id, target_pin_id, command_kind, requested_value, target_configuration_version, created_at, updated_at)
      SELECT ?, ?, 0, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM automation_rules WHERE id = ? AND mutation_id = ?)`)
      .bind(actionId, ruleId, draft.actions[0].targetDeviceId, draft.actions[0].targetPinId, draft.actions[0].commandKind,
        draft.actions[0].requestedValue, draft.actions[0].targetConfigurationVersion, now, now, ruleId, mutationId),
  ]);
  const created = await getAutomationRule(db, ruleId);
  if (!created) throw new AutomationError("Automation rule limit reached", "RULE_LIMIT", 409);
  return created;
}

function ruleAsDraft(rule: AutomationRuleRecord): AutomationRuleDraft {
  const trigger: AutomationRuleDraft["trigger"] = rule.trigger.kind === "THRESHOLD" ? {
    kind: "THRESHOLD", sourceDeviceId: rule.trigger.sourceDeviceId ?? undefined, sourcePinId: rule.trigger.sourcePinId ?? undefined,
    comparator: rule.trigger.comparator ?? undefined, thresholdValue: rule.trigger.thresholdValue ?? undefined,
    hysteresis: rule.trigger.hysteresis, holdForMs: rule.trigger.holdForMs, maxSampleAgeMs: rule.trigger.maxSampleAgeMs,
  } : rule.trigger.kind === "INTERVAL" ? {
    kind: "INTERVAL", intervalMs: rule.trigger.intervalMs ?? undefined,
  } : {
    kind: "SCHEDULE", scheduleMinuteUtc: rule.trigger.scheduleMinuteUtc ?? undefined,
    scheduleDaysMask: rule.trigger.scheduleDaysMask ?? undefined, scheduleTimezone: "UTC",
  };
  return {
    name: rule.name, description: rule.description, actionScope: rule.actionScope,
    trigger,
    actions: rule.actions.filter((action) => action.targetDeviceId).map((action) => ({
      targetDeviceId: action.targetDeviceId!, targetPinId: action.targetPinId, commandKind: action.commandKind, requestedValue: action.requestedValue,
    })),
    cooldownMs: rule.cooldownMs, rateLimitCount: rule.rateLimitCount, rateLimitWindowMs: rule.rateLimitWindowMs, maxChainDepth: rule.maxChainDepth,
  };
}

export async function updateAutomationRule(db: DatabaseBinding, ruleId: string, input: unknown, expectedRevision: number, updatedBy: string, now = Date.now()) {
  const current = await getAutomationRule(db, ruleId);
  if (!current) throw new AutomationError("Automation rule not found", "RULE_NOT_FOUND", 404);
  if (current.mode === "LIVE") throw new AutomationError("Disable the live rule before editing it", "RULE_LIVE", 409);
  if (current.revision !== expectedRevision) throw new AutomationError("Rule revision changed; reload before saving", "REVISION_CONFLICT", 409);
  const validation = await validateAutomationDraft(db, input);
  if (!validation.normalized) throwInvalid(validation.issues);
  const draft = validation.normalized; const nextRevision = current.revision + 1; const owner = actor(updatedBy); const mutationId = id("MUT");
  await db.batch([
    db.prepare(`UPDATE automation_rules SET name = ?, description = ?, mode = 'DISABLED', revision = ?, action_scope = ?,
      approved_revision = NULL, approved_by = NULL, approved_at = NULL, cooldown_ms = ?, rate_limit_count = ?,
      rate_limit_window_ms = ?, max_chain_depth = ?, mutation_id = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND archived_at IS NULL AND mode <> 'LIVE'`)
      .bind(draft.name, draft.description, nextRevision, draft.actionScope, draft.cooldownMs, draft.rateLimitCount,
        draft.rateLimitWindowMs, draft.maxChainDepth, mutationId, owner, now, ruleId, expectedRevision),
    db.prepare(`UPDATE automation_triggers SET kind = ?, source_device_id = ?, source_pin_id = ?, comparator = ?, threshold_value = ?,
      hysteresis = ?, hold_for_ms = ?, max_sample_age_ms = ?, source_unit = ?, source_configuration_version = ?, interval_ms = ?,
      schedule_minute_utc = ?, schedule_days_mask = ?, schedule_timezone = 'UTC', last_source_event_key = NULL,
      last_observed_value = NULL, condition_since_at = NULL, armed = 1, next_due_at = ?, last_evaluated_at = NULL,
      last_fired_at = NULL, updated_at = ? WHERE rule_id = ? AND EXISTS (
        SELECT 1 FROM automation_rules WHERE id = ? AND revision = ? AND mutation_id = ?
      )`).bind(draft.trigger.kind, draft.trigger.sourceDeviceId, draft.trigger.sourcePinId, draft.trigger.comparator,
        draft.trigger.thresholdValue, draft.trigger.hysteresis, draft.trigger.holdForMs, draft.trigger.maxSampleAgeMs,
        draft.trigger.sourceUnit, draft.trigger.sourceConfigurationVersion, draft.trigger.intervalMs,
        draft.trigger.scheduleMinuteUtc, draft.trigger.scheduleDaysMask, initialNextDue(draft.trigger, now), now, ruleId, ruleId, nextRevision, mutationId),
    db.prepare(`UPDATE automation_actions SET target_device_id = ?, target_pin_id = ?, command_kind = ?, requested_value = ?,
      target_configuration_version = ?, updated_at = ? WHERE rule_id = ? AND position = 0 AND EXISTS (
        SELECT 1 FROM automation_rules WHERE id = ? AND revision = ? AND mutation_id = ?
      )`).bind(draft.actions[0].targetDeviceId, draft.actions[0].targetPinId, draft.actions[0].commandKind,
        draft.actions[0].requestedValue, draft.actions[0].targetConfigurationVersion, now, ruleId, ruleId, nextRevision, mutationId),
  ]);
  const mutation = await db.prepare("SELECT mutation_id FROM automation_rules WHERE id = ? AND revision = ?").bind(ruleId, nextRevision).first<Row>();
  if (text(mutation?.mutation_id) !== mutationId) throw new AutomationError("Rule revision changed; reload before saving", "REVISION_CONFLICT", 409);
  const updated = await getAutomationRule(db, ruleId);
  if (!updated || updated.revision !== nextRevision) throw new AutomationError("Rule revision changed; reload before saving", "REVISION_CONFLICT", 409);
  return updated;
}

async function physicalHilPassed(db: DatabaseBinding, deviceId: string) {
  return Boolean(await db.prepare(`SELECT run.id FROM hardware_test_runs run JOIN devices device ON device.id = run.device_id
    WHERE run.device_id = ? AND run.status = 'PASSED' AND run.agent_version = device.agent_version
      AND run.validated_configuration_version = device.configuration_version
      AND COALESCE(run.validated_firmware_version, '') = COALESCE(device.firmware_version, '')
      AND run.completed_cycles >= run.target_cycles AND run.failure_count = 0 ORDER BY run.completed_at DESC LIMIT 1`).bind(deviceId).first<Row>());
}

async function staticCycleExists(db: DatabaseBinding, candidate: AutomationRuleRecord) {
  const rules = (await listAutomationRules(db)).filter((rule) => rule.id !== candidate.id && rule.mode === "LIVE");
  rules.push(candidate);
  const edges = new Map<string, string[]>();
  for (const rule of rules) {
    if (rule.trigger.kind !== "THRESHOLD" || !rule.trigger.sourceDeviceId || !rule.trigger.sourcePinId) continue;
    const from = `${rule.trigger.sourceDeviceId}:${rule.trigger.sourcePinId}`;
    for (const action of rule.actions) {
      if (!action.targetDeviceId) continue;
      const targets = edges.get(from) ?? [];
      targets.push(`${action.targetDeviceId}:${action.targetPinId}`);
      edges.set(from, targets);
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node); visited.add(node); return false;
  }
  return [...edges.keys()].some(visit);
}

export async function cancelQueuedAutomationForRule(db: DatabaseBinding, ruleId: string, reason = "Rule disabled", now = Date.now()) {
  await db.batch([
    db.prepare(`UPDATE gpio_commands SET status = 'FAILED', completed_at = ?, error = ?
      WHERE automation_rule_id = ? AND origin = 'AUTOMATION' AND status = 'QUEUED'`).bind(now, reason.slice(0, 180), ruleId),
    db.prepare(`UPDATE automation_action_runs SET status = 'CANCELLED', completed_at = ?, error = ?
      WHERE gpio_command_id IN (SELECT id FROM gpio_commands WHERE automation_rule_id = ? AND status = 'FAILED' AND error = ?)
        AND status IN ('PLANNED', 'QUEUED', 'DELIVERED')`).bind(now, reason.slice(0, 180), ruleId, reason.slice(0, 180)),
    db.prepare(`UPDATE automation_executions SET status = 'CANCELLED', completed_at = ?, reason = ?
      WHERE rule_id = ? AND status IN ('QUEUED', 'RUNNING') AND NOT EXISTS (
        SELECT 1 FROM automation_action_runs action WHERE action.execution_id = automation_executions.id AND action.status = 'DELIVERED'
      )`).bind(now, reason.slice(0, 180), ruleId),
  ]);
  const delivered = await db.prepare(`SELECT count(*) AS count FROM gpio_commands WHERE automation_rule_id = ? AND origin = 'AUTOMATION' AND status = 'DELIVERED'`).bind(ruleId).first<Row>();
  return Number(delivered?.count ?? 0);
}

export async function cancelQueuedAutomationForDevice(db: DatabaseBinding, deviceId: string, reason: string, pinIds?: string[], now = Date.now()) {
  const pinFilter = pinIds?.length ? `AND pin_id IN (${pinIds.map(() => "?").join(",")})` : "";
  const bindings = pinIds?.length ? pinIds : [];
  await db.prepare(`UPDATE gpio_commands SET status = 'FAILED', completed_at = ?, error = ?
    WHERE device_id = ? AND origin = 'AUTOMATION' AND status = 'QUEUED' ${pinFilter}`)
    .bind(now, reason.slice(0, 180), deviceId, ...bindings).run();
  await db.prepare(`UPDATE automation_action_runs SET status = 'CANCELLED', completed_at = ?, error = ?
    WHERE gpio_command_id IN (SELECT id FROM gpio_commands WHERE device_id = ? AND origin = 'AUTOMATION' AND status = 'FAILED' AND error = ?)
      AND status IN ('PLANNED', 'QUEUED', 'DELIVERED')`).bind(now, reason.slice(0, 180), deviceId, reason.slice(0, 180)).run();
  await db.prepare(`UPDATE automation_executions SET status = 'CANCELLED', completed_at = ?, reason = ?
    WHERE status IN ('QUEUED', 'RUNNING') AND id IN (SELECT execution_id FROM automation_action_runs WHERE status = 'CANCELLED')`).bind(now, reason.slice(0, 180)).run();
  const targetFilter = pinIds?.length ? `AND target_pin_id IN (${pinIds.map(() => "?").join(",")})` : "";
  const affected = await db.prepare(`SELECT DISTINCT rule_id FROM automation_actions WHERE target_device_id = ? ${targetFilter}`)
    .bind(deviceId, ...(pinIds ?? [])).all<Row>();
  for (const row of affected.results ?? []) {
    const rule = await getAutomationRule(db, text(row.rule_id));
    if (!rule) continue;
    const due = rule.trigger.kind === "THRESHOLD" ? null : nextDue(rule, now);
    await db.prepare(`UPDATE automation_triggers SET last_source_event_key = NULL, last_observed_value = NULL,
      condition_since_at = NULL, armed = 1, next_due_at = ?, last_evaluated_at = NULL, last_fired_at = NULL, updated_at = ?
      WHERE rule_id = ?`).bind(due, now, rule.id).run();
  }
}

export async function resetAutomationForSourceDevice(db: DatabaseBinding, deviceId: string, now = Date.now()) {
  await db.prepare(`UPDATE automation_triggers SET last_source_event_key = NULL, last_observed_value = NULL,
    condition_since_at = NULL, last_evaluated_at = NULL, updated_at = ?
    WHERE kind = 'THRESHOLD' AND source_device_id = ?`).bind(now, deviceId).run();
}

export async function setAutomationRuleMode(db: DatabaseBinding, ruleId: string, mode: AutomationRuleMode, expectedRevision: number, approvedBy: string, now = Date.now()) {
  const current = await getAutomationRule(db, ruleId);
  if (!current) throw new AutomationError("Automation rule not found", "RULE_NOT_FOUND", 404);
  if (current.revision !== expectedRevision) throw new AutomationError("Rule revision changed; reload before changing state", "REVISION_CONFLICT", 409);
  if (!["DISABLED", "DRY_RUN", "LIVE"].includes(mode)) throw new AutomationError("Invalid rule mode", "MODE_INVALID", 400);
  const validation = await validateAutomationDraft(db, ruleAsDraft(current));
  if (!validation.valid) throwInvalid(validation.issues);
  if (mode === "LIVE") {
    if (current.cooldownMs < AUTOMATION_MIN_LIVE_COOLDOWN_MS) throw new AutomationError("Live rules require at least a 5-second cooldown", "COOLDOWN_TOO_SHORT", 409);
    if (await staticCycleExists(db, current)) throw new AutomationError("Live rule would create a static automation dependency cycle", "AUTOMATION_LOOP", 409);
    const blockers = await suspensionReasons(db, { ...current, mode: "LIVE", approvedRevision: current.revision });
    if (blockers.length) throw new AutomationError(blockers[0], "AUTOMATION_SUSPENDED", 409, blockers.map((message) => ({ path: "state", code: "SUSPENDED", message, severity: "ERROR" })));
  }
  const owner = actor(approvedBy); const nextRevision = expectedRevision + 1; const mutationId = id("MUT");
  const nextDueAt = current.trigger.kind === "THRESHOLD" ? null : nextDue(current, now);
  await db.batch([
    db.prepare(`UPDATE automation_rules SET mode = ?, revision = ?, mutation_id = ?, approved_revision = NULL, approved_by = NULL, approved_at = NULL, updated_by = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND archived_at IS NULL`).bind(mode, nextRevision, mutationId, owner, now, ruleId, expectedRevision),
    db.prepare(`UPDATE automation_triggers SET last_source_event_key = NULL, last_observed_value = NULL,
      condition_since_at = NULL, armed = 1, next_due_at = ?, last_evaluated_at = NULL, last_fired_at = NULL, updated_at = ?
      WHERE rule_id = ? AND EXISTS (SELECT 1 FROM automation_rules WHERE id = ? AND revision = ? AND mutation_id = ?)`)
      .bind(nextDueAt, now, ruleId, ruleId, nextRevision, mutationId),
  ]);
  const mutation = await db.prepare("SELECT mutation_id FROM automation_rules WHERE id = ? AND revision = ?").bind(ruleId, nextRevision).first<Row>();
  if (text(mutation?.mutation_id) !== mutationId) throw new AutomationError("Rule revision changed; reload before changing state", "REVISION_CONFLICT", 409);
  if (mode !== "LIVE") await cancelQueuedAutomationForRule(db, ruleId, mode === "DISABLED" ? "Rule disabled" : "Rule changed to dry-run", now);
  let updated = await getAutomationRule(db, ruleId);
  if (!updated || updated.revision !== nextRevision || updated.mode !== mode) throw new AutomationError("Rule state changed concurrently; reload", "REVISION_CONFLICT", 409);
  if (mode === "LIVE") {
    const cycle = await staticCycleExists(db, updated);
    const blockers = await suspensionReasons(db, { ...updated, approvedRevision: updated.revision });
    if (cycle || blockers.length) {
      const reason = cycle ? "Live rule would create a static automation dependency cycle" : blockers[0];
      const failedRevision = nextRevision + 1; const failedMutationId = id("MUT");
      await db.batch([
        db.prepare(`UPDATE automation_rules SET mode = 'DISABLED', revision = ?, mutation_id = ?, approved_revision = NULL,
          approved_by = NULL, approved_at = NULL, updated_by = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND mutation_id = ? AND mode = 'LIVE'`)
          .bind(failedRevision, failedMutationId, owner, now, ruleId, nextRevision, mutationId),
        db.prepare(`UPDATE automation_triggers SET last_source_event_key = NULL, last_observed_value = NULL,
          condition_since_at = NULL, armed = 1, next_due_at = ?, last_evaluated_at = NULL, last_fired_at = NULL, updated_at = ?
          WHERE rule_id = ? AND EXISTS (SELECT 1 FROM automation_rules WHERE id = ? AND revision = ? AND mutation_id = ?)`)
          .bind(nextDueAt, now, ruleId, ruleId, failedRevision, failedMutationId),
      ]);
      await cancelQueuedAutomationForRule(db, ruleId, reason, now);
      throw new AutomationError(reason, cycle ? "AUTOMATION_LOOP" : "AUTOMATION_SUSPENDED", 409,
        blockers.map((message) => ({ path: "state", code: "SUSPENDED", message, severity: "ERROR" })));
    }
    const approved = await db.prepare(`UPDATE automation_rules SET approved_revision = revision, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND mutation_id = ? AND mode = 'LIVE' AND approved_revision IS NULL RETURNING id`)
      .bind(owner, now, now, ruleId, nextRevision, mutationId).first<Row>();
    if (!approved) throw new AutomationError("Rule state changed concurrently; reload", "REVISION_CONFLICT", 409);
    updated = await getAutomationRule(db, ruleId);
    if (!updated || updated.approvedRevision !== updated.revision) throw new AutomationError("Live approval was not published", "REVISION_CONFLICT", 409);
  }
  return { rule: updated, deliveredCommands: mode === "LIVE" ? 0 : Number((await db.prepare(`SELECT count(*) AS count FROM gpio_commands WHERE automation_rule_id = ? AND status = 'DELIVERED'`).bind(ruleId).first<Row>())?.count ?? 0) };
}

export async function archiveAutomationRule(db: DatabaseBinding, ruleId: string, expectedRevision: number, archivedBy: string, now = Date.now()) {
  const current = await getAutomationRule(db, ruleId);
  if (!current) throw new AutomationError("Automation rule not found", "RULE_NOT_FOUND", 404);
  if (current.mode !== "DISABLED") throw new AutomationError("Disable the rule before archiving it", "RULE_ACTIVE", 409);
  if (current.revision !== expectedRevision) throw new AutomationError("Rule revision changed; reload before archiving", "REVISION_CONFLICT", 409);
  const mutationId = id("MUT"); const nextRevision = expectedRevision + 1;
  await db.prepare(`UPDATE automation_rules SET archived_at = ?, revision = ?, mutation_id = ?, updated_at = ?, updated_by = ?
    WHERE id = ? AND revision = ? AND mode = 'DISABLED' AND archived_at IS NULL`).bind(now, nextRevision, mutationId, now, actor(archivedBy), ruleId, expectedRevision).run();
  const archived = await db.prepare("SELECT mutation_id FROM automation_rules WHERE id = ? AND revision = ? AND archived_at = ?")
    .bind(ruleId, nextRevision, now).first<Row>();
  if (text(archived?.mutation_id) !== mutationId) throw new AutomationError("Rule revision changed; reload before archiving", "REVISION_CONFLICT", 409);
}

async function createExecution(db: DatabaseBinding, rule: AutomationRuleRecord, input: {
  sourceKind: AutomationExecutionRecord["sourceKind"]; sourceEventKey: string; executionMode: "DRY_RUN" | "LIVE";
  status: AutomationExecutionStatus; actor: string; triggerValue?: number | null; triggerRecordedAt?: number | null;
  conditionSinceAt?: number | null; matched: boolean; reason: string; now: number;
  rootExecutionId?: string | null; parentExecutionId?: string | null; chainDepth?: number;
}, guarded = false) {
  const executionId = id("RUN");
  const baseSql = `INSERT OR IGNORE INTO automation_executions
    (id, rule_id, trigger_id, rule_revision, source_kind, source_event_key, execution_mode, status, actor,
      root_execution_id, parent_execution_id, chain_depth, trigger_value, trigger_recorded_at, condition_since_at,
      matched, reason, requested_at, started_at, completed_at)`;
  const terminal = !["QUEUED", "RUNNING"].includes(input.status);
  const executionStatement = guarded
    ? db.prepare(`${baseSql}
        SELECT ?, rule.id, ?, rule.revision, ?, ?, 'LIVE', 'QUEUED', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL
        FROM automation_rules rule WHERE rule.id = ? AND rule.archived_at IS NULL AND rule.mode = 'LIVE'
          AND rule.approved_revision = rule.revision AND rule.revision = ?
          AND NOT EXISTS (SELECT 1 FROM automation_executions active WHERE active.rule_id = rule.id AND active.status IN ('QUEUED', 'RUNNING'))
          AND NOT EXISTS (SELECT 1 FROM automation_executions recent WHERE recent.rule_id = rule.id AND recent.execution_mode = 'LIVE'
            AND recent.status IN ('QUEUED', 'RUNNING', 'ACKNOWLEDGED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'CANCELLED') AND recent.requested_at > ?)
          AND (SELECT count(*) FROM automation_executions counted WHERE counted.rule_id = rule.id AND counted.execution_mode = 'LIVE'
            AND counted.status IN ('QUEUED', 'RUNNING', 'ACKNOWLEDGED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'CANCELLED')
            AND counted.requested_at >= ?) < rule.rate_limit_count
        `).bind(executionId, rule.trigger.id, input.sourceKind, input.sourceEventKey, actor(input.actor),
          input.rootExecutionId ?? null, input.parentExecutionId ?? null, input.chainDepth ?? 0, input.triggerValue ?? null,
          input.triggerRecordedAt ?? null, input.conditionSinceAt ?? null, input.reason.slice(0, 240), input.now, input.now,
          rule.id, rule.revision, input.now - rule.cooldownMs, input.now - rule.rateLimitWindowMs)
    : db.prepare(`${baseSql} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(executionId, rule.id, rule.trigger.id, rule.revision, input.sourceKind, input.sourceEventKey, input.executionMode,
        input.status, actor(input.actor), input.rootExecutionId ?? null, input.parentExecutionId ?? null, input.chainDepth ?? 0,
        input.triggerValue ?? null, input.triggerRecordedAt ?? null, input.conditionSinceAt ?? null, input.matched ? 1 : 0,
        input.reason.slice(0, 240), input.now, input.now, terminal ? input.now : null);
  const actionStatus = input.status === "DRY_RUN" ? "DRY_RUN" : input.status === "NO_MATCH" || input.status === "ARMED" || input.status === "RESET" ? "PLANNED" : "PLANNED";
  const statements = [executionStatement];
  for (const action of rule.actions) {
    if (!action.targetDeviceId) continue;
    statements.push(db.prepare(`INSERT OR IGNORE INTO automation_action_runs
      (id, execution_id, action_id, position, target_device_id, target_pin_id, command_kind, requested_value, status, started_at, completed_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM automation_executions WHERE id = ?)`)
      .bind(id("STEP"), executionId, action.id, action.position, action.targetDeviceId, action.targetPinId,
        action.commandKind, action.requestedValue, actionStatus, input.now, terminal ? input.now : null, executionId));
  }
  await db.batch(statements);
  const row = await db.prepare("SELECT id FROM automation_executions WHERE id = ?").bind(executionId).first<Row>();
  if (!row) return null;
  await db.prepare(`DELETE FROM automation_executions WHERE status NOT IN ('QUEUED', 'RUNNING')
    AND NOT (execution_mode = 'LIVE'
      AND status IN ('ACKNOWLEDGED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'CANCELLED')
      AND requested_at >= (SELECT ? - MAX(rule.cooldown_ms, rule.rate_limit_window_ms)
        FROM automation_rules rule WHERE rule.id = automation_executions.rule_id)) AND id NOT IN (
    SELECT id FROM automation_executions ORDER BY requested_at DESC, id DESC LIMIT ?
  ) AND NOT EXISTS (SELECT 1 FROM gpio_commands command WHERE command.automation_execution_id = automation_executions.id
    AND command.status IN ('QUEUED', 'DELIVERED'))`).bind(input.now, AUTOMATION_EXECUTION_RETENTION).run();
  return getAutomationExecution(db, executionId);
}

async function admissionBlock(db: DatabaseBinding, rule: AutomationRuleRecord, now: number) {
  const active = await db.prepare(`SELECT id FROM automation_executions WHERE rule_id = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1`).bind(rule.id).first<Row>();
  if (active) return { status: "BLOCKED" as const, reason: "A prior execution is still active", retryAfterMs: 1_000 };
  const recent = await db.prepare(`SELECT requested_at FROM automation_executions WHERE rule_id = ? AND execution_mode = 'LIVE'
    AND status IN ('QUEUED', 'RUNNING', 'ACKNOWLEDGED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'CANCELLED')
    ORDER BY requested_at DESC LIMIT 1`).bind(rule.id).first<Row>();
  if (recent && Number(recent.requested_at) > now - rule.cooldownMs) return { status: "COOLDOWN" as const, reason: "Rule cooldown is active", retryAfterMs: Number(recent.requested_at) + rule.cooldownMs - now };
  const count = await db.prepare(`SELECT count(*) AS count FROM automation_executions WHERE rule_id = ? AND execution_mode = 'LIVE'
    AND status IN ('QUEUED', 'RUNNING', 'ACKNOWLEDGED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'CANCELLED') AND requested_at >= ?`)
    .bind(rule.id, now - rule.rateLimitWindowMs).first<Row>();
  if (Number(count?.count ?? 0) >= rule.rateLimitCount) return { status: "RATE_LIMITED" as const, reason: "Rule execution-rate limit is active", retryAfterMs: rule.rateLimitWindowMs };
  return { status: "BLOCKED" as const, reason: "Rule changed or was disabled before dispatch", retryAfterMs: undefined };
}

async function chainBlock(db: DatabaseBinding, rule: AutomationRuleRecord, context: EvaluationContext) {
  const depth = context.chainDepth ?? 0;
  if (depth > rule.maxChainDepth) return "Automation causation depth exceeded the rule limit";
  const root = context.rootExecutionId;
  if (!root) return null;
  const visited = await db.prepare(`SELECT id FROM automation_executions WHERE rule_id = ? AND (id = ? OR root_execution_id = ?) LIMIT 1`)
    .bind(rule.id, root, root).first<Row>();
  return visited ? "Automation causation chain already visited this rule" : null;
}

async function dispatchMatchedRule(db: DatabaseBinding, rule: AutomationRuleRecord, evidence: {
  sourceKind: AutomationExecutionRecord["sourceKind"]; sourceEventKey: string; triggerValue: number | null;
  triggerRecordedAt: number | null; conditionSinceAt: number | null; reason: string;
}, context: EvaluationContext) {
  if (!context.preview && rule.mode === "LIVE") await expireGpioCommands(db);
  const loopReason = await chainBlock(db, rule, context);
  if (loopReason) return createExecution(db, rule, {
    ...evidence, executionMode: "LIVE", status: "LOOP_BLOCKED", actor: context.actor, matched: true,
    reason: loopReason, now: context.now, rootExecutionId: context.rootExecutionId, parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
  });
  if (context.preview || rule.mode === "DRY_RUN") return createExecution(db, rule, {
    ...evidence, executionMode: "DRY_RUN", status: "DRY_RUN", actor: context.actor, matched: true,
    reason: `Simulation only — no commands sent. ${evidence.reason}`.slice(0, 240), now: context.now,
    rootExecutionId: context.rootExecutionId, parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
  });
  const execution = await createExecution(db, rule, {
    ...evidence, executionMode: "LIVE", status: "QUEUED", actor: context.actor, matched: true,
    reason: evidence.reason, now: context.now, rootExecutionId: context.rootExecutionId,
    parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
  }, true);
  if (!execution) {
    const block = await admissionBlock(db, rule, context.now);
    return createExecution(db, rule, {
      ...evidence, executionMode: "LIVE", status: block.status, actor: context.actor, matched: true,
      sourceEventKey: `${evidence.sourceEventKey}:suppressed`, reason: block.reason, now: context.now,
      rootExecutionId: context.rootExecutionId, parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
    });
  }
  const action = rule.actions[0];
  const target = action.targetDeviceId ? await getDevice(db, action.targetDeviceId) : null;
  const targetPin = action.targetDeviceId ? (await getDevicePins(db, action.targetDeviceId)).find((pin) => pin.pinId === action.targetPinId) : null;
  let blockReason: string | null = null;
  if (!target || !targetPin) blockReason = "Automation target no longer exists";
  else if (!target.automationArmed) blockReason = "Target device is not armed for automation";
  else if (target.configurationVersion !== action.targetConfigurationVersion) blockReason = "Target configuration changed after rule approval";
  else if (!target.simulated && rule.actionScope !== "PHYSICAL_CONTROL") blockReason = "Rule is scoped to simulators only";
  else if (!target.simulated && !await physicalHilPassed(db, target.id)) blockReason = "Physical automation requires a passing Hardware-in-the-Loop record";
  if (blockReason) {
    await db.batch([
      db.prepare(`UPDATE automation_action_runs SET status = 'FAILED', completed_at = ?, error = ? WHERE execution_id = ? AND status IN ('PLANNED', 'QUEUED')`).bind(context.now, blockReason, execution.id),
      db.prepare(`UPDATE automation_executions SET status = 'BLOCKED', completed_at = ?, reason = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`).bind(context.now, blockReason, execution.id),
    ]);
    return getAutomationExecution(db, execution.id);
  }
  try {
    const command = await issueGpioCommand(db, {
      deviceId: target!.id, pinId: action.targetPinId, kind: action.commandKind, requestedValue: action.requestedValue,
      actor: `automation:${rule.id}`, origin: "AUTOMATION", automationRuleId: rule.id,
      automationRuleRevision: rule.revision, automationActionId: action.id, automationExecutionId: execution.id,
    });
    await db.prepare("UPDATE automation_triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?").bind(context.now, context.now, rule.trigger.id).run();
    if (target!.simulated) {
      const terminal = await executeServerSimulatorCommand(db, target!.id, command.id);
      const refreshed = await refreshAutomationExecution(db, execution.id);
      if (terminal?.status === "ACKNOWLEDGED") await continueAutomationFromCommand(db, command.id, context.now);
      return refreshed;
    }
    return refreshAutomationExecution(db, execution.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Automation command was blocked";
    await db.batch([
      db.prepare(`UPDATE automation_action_runs SET status = 'FAILED', completed_at = ?, error = ? WHERE execution_id = ? AND status IN ('PLANNED', 'QUEUED')`).bind(context.now, reason.slice(0, 180), execution.id),
      db.prepare(`UPDATE automation_executions SET status = 'BLOCKED', completed_at = ?, reason = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')`).bind(context.now, reason.slice(0, 240), execution.id),
    ]);
    return getAutomationExecution(db, execution.id);
  }
}

async function readThresholdEvidence(db: DatabaseBinding, rule: AutomationRuleRecord) {
  if (!rule.trigger.sourceDeviceId || !rule.trigger.sourcePinId) return null;
  return db.prepare(`SELECT device.connection_state, device.simulated, device.control_ready, device.configuration_version,
      pin.mode, pin.confirmed_value, pin.engineering_unit, pin.updated_at, pin.sampled_at,
      (SELECT sample.id FROM device_telemetry_samples sample WHERE sample.device_id = pin.device_id AND sample.pin_id = pin.pin_id
        ORDER BY sample.recorded_at DESC, sample.id DESC LIMIT 1) AS telemetry_id,
      (SELECT sample.recorded_at FROM device_telemetry_samples sample WHERE sample.device_id = pin.device_id AND sample.pin_id = pin.pin_id
        ORDER BY sample.recorded_at DESC, sample.id DESC LIMIT 1) AS telemetry_recorded_at,
      (SELECT sample.engineering_value FROM device_telemetry_samples sample WHERE sample.device_id = pin.device_id AND sample.pin_id = pin.pin_id
        ORDER BY sample.recorded_at DESC, sample.id DESC LIMIT 1) AS telemetry_value,
      (SELECT sample.engineering_unit FROM device_telemetry_samples sample WHERE sample.device_id = pin.device_id AND sample.pin_id = pin.pin_id
        ORDER BY sample.recorded_at DESC, sample.id DESC LIMIT 1) AS telemetry_unit
    FROM devices device JOIN device_pins pin ON pin.device_id = device.id
    WHERE device.id = ? AND pin.pin_id = ?`).bind(rule.trigger.sourceDeviceId, rule.trigger.sourcePinId).first<Row>();
}

function thresholdEvidenceValue(evidence: Row) {
  return evidence.mode === "ANALOG" && evidence.telemetry_id ? numberOrNull(evidence.telemetry_value) : numberOrNull(evidence.confirmed_value);
}

function thresholdEvidenceRecordedAt(evidence: Row) {
  return Number(evidence.mode === "ANALOG" && evidence.telemetry_id
    ? evidence.telemetry_recorded_at
    : evidence.sampled_at ?? evidence.updated_at);
}

async function resetThreshold(db: DatabaseBinding, rule: AutomationRuleRecord, evidence: Row | null, context: EvaluationContext, reason: string, status: "RESET" | "BLOCKED") {
  const value = evidence ? thresholdEvidenceValue(evidence) : null;
  const recordedAt = evidence ? thresholdEvidenceRecordedAt(evidence) : null;
  const eventKey = evidence ? `${evidence.telemetry_id ? `telemetry:${evidence.telemetry_id}` : `pin:${rule.trigger.sourceDeviceId}:${rule.trigger.sourcePinId}:${recordedAt}:${value}`}` : `missing:${context.now}`;
  if (!context.preview) await db.prepare(`UPDATE automation_triggers SET condition_since_at = NULL,
    armed = CASE WHEN ? = 'RESET' THEN 1 ELSE armed END, last_source_event_key = ?, last_observed_value = ?,
    last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
    .bind(status, eventKey, value, context.now, context.now, rule.trigger.id).run();
  return createExecution(db, rule, {
    sourceKind: context.sourceKindOverride ?? "THRESHOLD", sourceEventKey: context.preview ? `preview:${crypto.randomUUID()}` : `${eventKey}:${status.toLowerCase()}`,
    executionMode: context.preview ? "DRY_RUN" : rule.mode === "DRY_RUN" ? "DRY_RUN" : "LIVE", status,
    actor: context.actor, triggerValue: value, triggerRecordedAt: recordedAt, conditionSinceAt: rule.trigger.conditionSinceAt,
    matched: false, reason, now: context.now, rootExecutionId: context.rootExecutionId,
    parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
  });
}

async function evaluateThreshold(db: DatabaseBinding, rule: AutomationRuleRecord, context: EvaluationContext) {
  const evidence = await readThresholdEvidence(db, rule);
  if (!evidence || thresholdEvidenceValue(evidence) === null) return resetThreshold(db, rule, evidence, context, "Source value is missing", "BLOCKED");
  const value = thresholdEvidenceValue(evidence)!;
  const recordedAt = thresholdEvidenceRecordedAt(evidence);
  const eventKey = evidence.telemetry_id ? `telemetry:${evidence.telemetry_id}` : `pin:${rule.trigger.sourceDeviceId}:${rule.trigger.sourcePinId}:${recordedAt}:${value}`;
  const unit = evidence.mode === "ANALOG" ? stringOrNull(evidence.telemetry_unit) ?? stringOrNull(evidence.engineering_unit) ?? "V" : null;
  if (text(evidence.connection_state) !== "ONLINE") return resetThreshold(db, rule, evidence, context, "Source device is offline", "BLOCKED");
  if (!booleanValue(evidence.simulated) && !booleanValue(evidence.control_ready)) return resetThreshold(db, rule, evidence, context, "Source device has no accepted current-session snapshot", "BLOCKED");
  if (!booleanValue(evidence.simulated) && rule.trigger.sourceDeviceId && !await physicalHilPassed(db, rule.trigger.sourceDeviceId)) return resetThreshold(db, rule, evidence, context, "Physical automation source requires a current passing Hardware-in-the-Loop record", "BLOCKED");
  if (Number(evidence.configuration_version) !== rule.trigger.sourceConfigurationVersion || unit !== rule.trigger.sourceUnit) return resetThreshold(db, rule, evidence, context, "Source calibration or configuration changed", "BLOCKED");
  if (context.now - recordedAt > rule.trigger.maxSampleAgeMs) return resetThreshold(db, rule, evidence, context, "Source sample is stale", "BLOCKED");
  if (!context.preview && rule.trigger.conditionSinceAt !== null && rule.trigger.lastEvaluatedAt !== null
    && context.now - rule.trigger.lastEvaluatedAt > rule.trigger.maxSampleAgeMs) {
    return resetThreshold(db, rule, evidence, context, "Fresh-sample continuity was interrupted", "BLOCKED");
  }
  if (!context.preview && eventKey === rule.trigger.lastSourceEventKey) return null;
  const comparator = rule.trigger.comparator!; const threshold = rule.trigger.thresholdValue!;
  const matched = thresholdMatches(comparator, value, threshold);
  const reset = thresholdHasReset(comparator, value, threshold, rule.trigger.hysteresis);
  if (!rule.trigger.armed) {
    if (reset) return resetThreshold(db, rule, evidence, context, "Threshold crossed the hysteresis reset boundary", "RESET");
    if (!context.preview) await db.prepare(`UPDATE automation_triggers SET last_source_event_key = ?, last_observed_value = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
      .bind(eventKey, value, context.now, context.now, rule.trigger.id).run();
    return context.preview ? createExecution(db, rule, {
      sourceKind: "DRY_RUN", sourceEventKey: `preview:${crypto.randomUUID()}`, executionMode: "DRY_RUN", status: "NO_MATCH",
      actor: context.actor, triggerValue: value, triggerRecordedAt: recordedAt, conditionSinceAt: rule.trigger.conditionSinceAt,
      matched: false, reason: "Rule is latched until the hysteresis reset boundary is crossed", now: context.now,
    }) : null;
  }
  if (!matched) {
    const hadCondition = rule.trigger.conditionSinceAt !== null;
    if (!context.preview) await db.prepare(`UPDATE automation_triggers SET condition_since_at = NULL, last_source_event_key = ?,
      last_observed_value = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ?`).bind(eventKey, value, context.now, context.now, rule.trigger.id).run();
    if (!context.preview && !hadCondition) return null;
    return createExecution(db, rule, {
      sourceKind: context.preview ? "DRY_RUN" : context.sourceKindOverride ?? "THRESHOLD", sourceEventKey: context.preview ? `preview:${crypto.randomUUID()}` : `${eventKey}:reset`,
      executionMode: context.preview || rule.mode === "DRY_RUN" ? "DRY_RUN" : "LIVE", status: context.preview ? "NO_MATCH" : "RESET",
      actor: context.actor, triggerValue: value, triggerRecordedAt: recordedAt, conditionSinceAt: rule.trigger.conditionSinceAt,
      matched: false, reason: "Threshold predicate is false", now: context.now,
      rootExecutionId: context.rootExecutionId, parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
    });
  }
  if (context.preview) {
    const holdSatisfied = rule.trigger.holdForMs === 0 || rule.trigger.conditionSinceAt !== null && recordedAt - rule.trigger.conditionSinceAt >= rule.trigger.holdForMs;
    if (!holdSatisfied) return createExecution(db, rule, {
      sourceKind: "DRY_RUN", sourceEventKey: `preview:${crypto.randomUUID()}`, executionMode: "DRY_RUN", status: "NO_MATCH",
      actor: context.actor, triggerValue: value, triggerRecordedAt: recordedAt, conditionSinceAt: rule.trigger.conditionSinceAt,
      matched: false, reason: rule.trigger.conditionSinceAt === null
        ? `Predicate matches; FOR ${rule.trigger.holdForMs} ms has not started in preview state`
        : "Predicate matches but the FOR duration is not yet satisfied",
      now: context.now,
    });
    return dispatchMatchedRule(db, rule, {
      sourceKind: "DRY_RUN", sourceEventKey: `preview:${crypto.randomUUID()}`, triggerValue: value, triggerRecordedAt: recordedAt,
      conditionSinceAt: rule.trigger.conditionSinceAt, reason: "Predicate and FOR duration match",
    }, context);
  }
  let conditionSince = rule.trigger.conditionSinceAt;
  if (conditionSince === null) {
    conditionSince = recordedAt;
    await db.prepare(`UPDATE automation_triggers SET condition_since_at = ?, last_source_event_key = ?, last_observed_value = ?,
      last_evaluated_at = ?, updated_at = ? WHERE id = ? AND condition_since_at IS NULL AND armed = 1`)
      .bind(conditionSince, eventKey, value, context.now, context.now, rule.trigger.id).run();
    if (rule.trigger.holdForMs > 0) return createExecution(db, rule, {
      sourceKind: context.sourceKindOverride ?? "THRESHOLD", sourceEventKey: `${eventKey}:armed`,
      executionMode: rule.mode === "DRY_RUN" ? "DRY_RUN" : "LIVE", status: "ARMED", actor: context.actor,
      triggerValue: value, triggerRecordedAt: recordedAt, conditionSinceAt: conditionSince, matched: true,
      reason: `Predicate matched; waiting for ${rule.trigger.holdForMs} ms of fresh accepted samples`, now: context.now,
      rootExecutionId: context.rootExecutionId, parentExecutionId: context.parentExecutionId, chainDepth: context.chainDepth,
    });
  } else {
    await db.prepare(`UPDATE automation_triggers SET last_source_event_key = ?, last_observed_value = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ? AND armed = 1`)
      .bind(eventKey, value, context.now, context.now, rule.trigger.id).run();
  }
  if (recordedAt - conditionSince < rule.trigger.holdForMs) return null;
  const claimed = await db.prepare(`UPDATE automation_triggers SET armed = 0, last_fired_at = ?, updated_at = ?
    WHERE id = ? AND armed = 1 AND condition_since_at = ? RETURNING id`).bind(context.now, context.now, rule.trigger.id, conditionSince).first<Row>();
  if (!claimed) return null;
  return dispatchMatchedRule(db, rule, {
    sourceKind: context.sourceKindOverride ?? "THRESHOLD", sourceEventKey: eventKey, triggerValue: value,
    triggerRecordedAt: recordedAt, conditionSinceAt: conditionSince, reason: "Predicate and required fresh-sample duration matched",
  }, context);
}

function nextDue(rule: AutomationRuleRecord, now: number) {
  if (rule.trigger.kind === "INTERVAL") return now + rule.trigger.intervalMs!;
  return nextScheduleOccurrence(now, rule.trigger.scheduleMinuteUtc!, rule.trigger.scheduleDaysMask!);
}

async function evaluateDueRule(db: DatabaseBinding, rule: AutomationRuleRecord, context: EvaluationContext) {
  const due = rule.trigger.nextDueAt;
  if (due === null || due > context.now) {
    if (!context.preview) return null;
    return createExecution(db, rule, {
      sourceKind: "DRY_RUN", sourceEventKey: `preview:${crypto.randomUUID()}`, executionMode: "DRY_RUN", status: "NO_MATCH",
      actor: context.actor, matched: false, reason: due === null ? "No next occurrence is configured" : `Next UTC occurrence is ${new Date(due).toISOString()}`,
      now: context.now,
    });
  }
  if (context.preview) return dispatchMatchedRule(db, rule, {
    sourceKind: "DRY_RUN", sourceEventKey: `preview:${crypto.randomUUID()}`, triggerValue: null, triggerRecordedAt: due,
    conditionSinceAt: null, reason: `Occurrence was due at ${new Date(due).toISOString()}`,
  }, context);
  const claimed = await db.prepare(`UPDATE automation_triggers SET next_due_at = ?, last_evaluated_at = ?, updated_at = ?
    WHERE id = ? AND next_due_at = ? RETURNING id`).bind(nextDue(rule, context.now), context.now, context.now, rule.trigger.id, due).first<Row>();
  if (!claimed) return null;
  return dispatchMatchedRule(db, rule, {
    sourceKind: context.sourceKindOverride ?? rule.trigger.kind, sourceEventKey: `${rule.trigger.kind.toLowerCase()}:${rule.trigger.id}:${due}`,
    triggerValue: null, triggerRecordedAt: due, conditionSinceAt: null,
    reason: `Best-effort UTC occurrence was due at ${new Date(due).toISOString()}; missed occurrences are not replayed`,
  }, context);
}

async function evaluateRule(db: DatabaseBinding, rule: AutomationRuleRecord, context: EvaluationContext) {
  if (!context.preview && rule.mode === "DISABLED") return null;
  return rule.trigger.kind === "THRESHOLD" ? evaluateThreshold(db, rule, context) : evaluateDueRule(db, rule, context);
}

export async function evaluateAutomationRule(db: DatabaseBinding, ruleId: string, input: {
  mode: "DRY_RUN" | "MANUAL"; expectedRevision: number; confirmHardware?: boolean; actor: string; now?: number;
}) {
  if (input.mode !== "DRY_RUN" && input.mode !== "MANUAL") throw new AutomationError("Evaluation mode must be DRY_RUN or MANUAL", "MODE_INVALID", 400);
  const rule = await getAutomationRule(db, ruleId);
  if (!rule) throw new AutomationError("Automation rule not found", "RULE_NOT_FOUND", 404);
  if (rule.revision !== input.expectedRevision) throw new AutomationError("Rule revision changed; reload before evaluating", "REVISION_CONFLICT", 409);
  if (input.mode === "MANUAL" && (rule.mode !== "LIVE" || input.confirmHardware !== true)) throw new AutomationError("Live manual evaluation requires an enabled rule and explicit hardware confirmation", "LIVE_CONFIRMATION_REQUIRED", 409);
  return evaluateRule(db, rule, { now: input.now ?? Date.now(), actor: actor(input.actor), preview: input.mode === "DRY_RUN", confirmHardware: input.confirmHardware, sourceKindOverride: input.mode === "MANUAL" ? "MANUAL" : undefined });
}

export async function evaluateAutomationForDevice(db: DatabaseBinding, sourceDeviceId: string, now = Date.now(), lineage: {
  rootExecutionId?: string | null; parentExecutionId?: string | null; chainDepth?: number;
} = {}) {
  const rows = await db.prepare(`SELECT rule_id FROM automation_triggers WHERE kind = 'THRESHOLD' AND source_device_id = ?
    AND rule_id IN (SELECT id FROM automation_rules WHERE mode IN ('DRY_RUN', 'LIVE') AND archived_at IS NULL)
    ORDER BY rule_id`).bind(sourceDeviceId).all<Row>();
  const executions: AutomationExecutionRecord[] = [];
  for (const row of rows.results ?? []) {
    const rule = await getAutomationRule(db, text(row.rule_id));
    if (!rule) continue;
    const result = await evaluateRule(db, rule, { now, actor: `automation:${rule.id}`, ...lineage });
    if (result) executions.push(result);
  }
  return executions;
}

export async function runDueAutomationCycle(db: DatabaseBinding, now = Date.now()) {
  const rows = await db.prepare(`SELECT trigger.rule_id FROM automation_triggers trigger JOIN automation_rules rule ON rule.id = trigger.rule_id
    WHERE trigger.kind IN ('INTERVAL', 'SCHEDULE') AND trigger.next_due_at <= ? AND rule.mode IN ('DRY_RUN', 'LIVE')
      AND rule.archived_at IS NULL ORDER BY trigger.next_due_at LIMIT 50`).bind(now).all<Row>();
  const executions: AutomationExecutionRecord[] = [];
  for (const row of rows.results ?? []) {
    const rule = await getAutomationRule(db, text(row.rule_id));
    if (!rule) continue;
    const result = await evaluateRule(db, rule, { now, actor: `automation:${rule.id}` });
    if (result) executions.push(result);
  }
  return executions;
}

export async function refreshAutomationExecution(db: DatabaseBinding, executionId: string) {
  await expireGpioCommands(db);
  const execution = await getAutomationExecution(db, executionId);
  if (!execution || !["QUEUED", "RUNNING"].includes(execution.status)) return execution;
  for (const action of execution.actions) {
    if (!action.gpioCommandId) continue;
    const command = await db.prepare("SELECT status, error, delivered_at, completed_at FROM gpio_commands WHERE id = ?").bind(action.gpioCommandId).first<Row>();
    if (!command) continue;
    const status = text(command.status);
    const mapped = status === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : status === "TIMED_OUT" ? "TIMED_OUT" : status === "FAILED" ? "FAILED" : status === "DELIVERED" ? "DELIVERED" : "QUEUED";
    await db.prepare(`UPDATE automation_action_runs SET status = ?, error = ?, started_at = COALESCE(started_at, ?),
      completed_at = ? WHERE id = ?`).bind(mapped, text(command.error), numberOrNull(command.delivered_at) ?? action.startedAt,
      ["ACKNOWLEDGED", "TIMED_OUT", "FAILED"].includes(mapped) ? numberOrNull(command.completed_at) ?? Date.now() : null, action.id).run();
  }
  const actions = await actionRuns(db, executionId);
  const active = actions.filter((item) => item.status === "QUEUED" || item.status === "DELIVERED").length;
  const acknowledged = actions.filter((item) => item.status === "ACKNOWLEDGED").length;
  const timedOut = actions.filter((item) => item.status === "TIMED_OUT").length;
  const failed = actions.filter((item) => item.status === "FAILED" || item.status === "CANCELLED").length;
  const status: AutomationExecutionStatus = active > 0 ? actions.some((item) => item.status === "DELIVERED") ? "RUNNING" : "QUEUED"
    : acknowledged === actions.length && actions.length > 0 ? "ACKNOWLEDGED"
    : acknowledged > 0 ? "PARTIAL" : timedOut > 0 ? "TIMED_OUT" : failed > 0 ? "FAILED" : execution.status;
  const terminal = !["QUEUED", "RUNNING"].includes(status);
  await db.prepare(`UPDATE automation_executions SET status = ?, started_at = CASE WHEN ? = 'RUNNING' THEN COALESCE(started_at, ?) ELSE started_at END,
    completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END,
    reason = CASE WHEN ? = 'ACKNOWLEDGED' THEN 'All automation commands were acknowledged' ELSE reason END WHERE id = ?`)
    .bind(status, status, Date.now(), terminal ? 1 : 0, Date.now(), status, executionId).run();
  return getAutomationExecution(db, executionId);
}

export async function refreshAutomationExecutionForCommand(db: DatabaseBinding, commandId: string) {
  const row = await db.prepare("SELECT automation_execution_id FROM gpio_commands WHERE id = ?").bind(commandId).first<Row>();
  return row?.automation_execution_id ? refreshAutomationExecution(db, text(row.automation_execution_id)) : null;
}

export async function continueAutomationFromCommand(db: DatabaseBinding, commandId: string, now = Date.now()) {
  const row = await db.prepare(`SELECT command.device_id, command.status, command.automation_execution_id,
      execution.root_execution_id, execution.chain_depth
    FROM gpio_commands command LEFT JOIN automation_executions execution ON execution.id = command.automation_execution_id
    WHERE command.id = ?`).bind(commandId).first<Row>();
  if (!row || text(row.status) !== "ACKNOWLEDGED") return [];
  const parentExecutionId = stringOrNull(row.automation_execution_id);
  const rootExecutionId = stringOrNull(row.root_execution_id) ?? parentExecutionId;
  return evaluateAutomationForDevice(db, text(row.device_id), now, {
    rootExecutionId, parentExecutionId, chainDepth: Number(row.chain_depth ?? -1) + 1,
  });
}

export async function listAutomationExecutions(db: DatabaseBinding, filters: {
  ruleId?: string | null; status?: string | null; sourceKind?: string | null; limit?: number;
} = {}) {
  await expireGpioCommands(db);
  const activeRows = await db.prepare("SELECT id FROM automation_executions WHERE status IN ('QUEUED', 'RUNNING') ORDER BY requested_at LIMIT 50").all<Row>();
  for (const active of activeRows.results ?? []) await refreshAutomationExecution(db, text(active.id));
  const statuses: AutomationExecutionStatus[] = ["NO_MATCH", "ARMED", "RESET", "DRY_RUN", "QUEUED", "RUNNING", "ACKNOWLEDGED", "PARTIAL", "BLOCKED", "FAILED", "TIMED_OUT", "COOLDOWN", "RATE_LIMITED", "LOOP_BLOCKED", "CANCELLED"];
  if (filters.status && !statuses.includes(filters.status as AutomationExecutionStatus)) throw new AutomationError("Invalid execution status filter", "FILTER_INVALID", 400);
  const sources = ["THRESHOLD", "INTERVAL", "SCHEDULE", "MANUAL", "DRY_RUN"];
  if (filters.sourceKind && !sources.includes(filters.sourceKind)) throw new AutomationError("Invalid execution source filter", "FILTER_INVALID", 400);
  const clauses = ["1 = 1"]; const values: unknown[] = [];
  if (filters.ruleId) { clauses.push("execution.rule_id = ?"); values.push(filters.ruleId.slice(0, 80)); }
  if (filters.status) { clauses.push("execution.status = ?"); values.push(filters.status); }
  if (filters.sourceKind) { clauses.push("execution.source_kind = ?"); values.push(filters.sourceKind); }
  const limit = Math.max(1, Math.min(500, Number.isFinite(filters.limit) ? Math.round(filters.limit!) : 100));
  values.push(limit);
  const rows = await db.prepare(`SELECT execution.*, rule.name AS rule_name FROM automation_executions execution
    JOIN automation_rules rule ON rule.id = execution.rule_id WHERE ${clauses.join(" AND ")}
    ORDER BY execution.requested_at DESC, execution.id DESC LIMIT ?`).bind(...values).all<Row>();
  const executions: AutomationExecutionRecord[] = [];
  for (const row of rows.results ?? []) {
    const status = text(row.status);
    const current = status === "QUEUED" || status === "RUNNING" ? await refreshAutomationExecution(db, text(row.id)) : mapExecution(row, await actionRuns(db, text(row.id)));
    if (current) executions.push(current);
  }
  return executions;
}
