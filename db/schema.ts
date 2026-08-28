import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const deviceGroups = sqliteTable("device_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [index("device_groups_name_idx").on(table.name)]);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  boardProfileId: text("board_profile_id").notNull(),
  kind: text("kind").notNull().default("PHYSICAL"),
  connectionState: text("connection_state").notNull().default("UNKNOWN"),
  groupId: text("group_id").references(() => deviceGroups.id, { onDelete: "set null" }),
  agentVersion: text("agent_version"),
  firmwareVersion: text("firmware_version"),
  rssiDbm: integer("rssi_dbm"),
  ipAddress: text("ip_address"),
  lastSeenAt: integer("last_seen_at"),
  lastConnectedAt: integer("last_connected_at"),
  lastDisconnectedAt: integer("last_disconnected_at"),
  simulated: integer("simulated", { mode: "boolean" }).notNull().default(false),
  maintenanceMode: integer("maintenance_mode", { mode: "boolean" }).notNull().default(false),
  monitorOnly: integer("monitor_only", { mode: "boolean" }).notNull().default(false),
  automationArmed: integer("automation_armed", { mode: "boolean" }).notNull().default(false),
  controlReady: integer("control_ready", { mode: "boolean" }).notNull().default(false),
  firmwareFailsafeMode: text("firmware_failsafe_mode").notNull().default("NOT_REPORTED"),
  firmwareFailsafeTimeoutMs: integer("firmware_failsafe_timeout_ms"),
  firmwareFailsafeReportedAt: integer("firmware_failsafe_reported_at"),
  configurationVersion: integer("configuration_version").notNull().default(1),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index("devices_name_idx").on(table.name),
  index("devices_state_idx").on(table.connectionState),
  index("devices_profile_idx").on(table.boardProfileId),
  index("devices_group_idx").on(table.groupId),
]);

export const devicePins = sqliteTable("device_pins", {
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  pinId: text("pin_id").notNull(),
  label: text("label").notNull().default(""),
  mode: text("mode").notNull().default("INPUT"),
  confirmedValue: real("confirmed_value"),
  confirmedRawValue: real("confirmed_raw_value"),
  sampledAt: integer("sampled_at"),
  logicalLowLabel: text("logical_low_label"),
  logicalHighLabel: text("logical_high_label"),
  engineeringUnit: text("engineering_unit"),
  scaleInputLow: real("scale_input_low"),
  scaleOutputLow: real("scale_output_low"),
  scaleInputHigh: real("scale_input_high"),
  scaleOutputHigh: real("scale_output_high"),
  serverSafeValue: real("server_safe_value"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  primaryKey({ columns: [table.deviceId, table.pinId] }),
  index("device_pins_device_idx").on(table.deviceId),
]);

export const deviceConnectionEvents = sqliteTable("device_connection_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  reason: text("reason").notNull().default(""),
  occurredAt: integer("occurred_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [index("device_connection_events_device_time_idx").on(table.deviceId, table.occurredAt)]);

export const enrollmentTokens = sqliteTable("enrollment_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  boardProfileId: text("board_profile_id").notNull(),
  deviceName: text("device_name").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  usedAt: integer("used_at"),
  usedByDeviceId: text("used_by_device_id").references(() => devices.id, { onDelete: "set null" }),
  revokedAt: integer("revoked_at"),
}, (table) => [
  uniqueIndex("enrollment_tokens_hash_idx").on(table.tokenHash),
  index("enrollment_tokens_expiry_idx").on(table.expiresAt),
]);

export const deviceGatewayRateLimits = sqliteTable("device_gateway_rate_limits", {
  bucketKey: text("bucket_key").primaryKey(),
  windowStartedAt: integer("window_started_at").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("device_gateway_rate_limits_updated_idx").on(table.updatedAt)]);

export const operatorUsers = sqliteTable("operator_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("OWNER"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  disabledAt: integer("disabled_at"),
}, (table) => [uniqueIndex("operator_users_email_idx").on(table.email)]);

export const operatorSessions = sqliteTable("operator_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => operatorUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  expiresAt: integer("expires_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  revokedAt: integer("revoked_at"),
}, (table) => [
  uniqueIndex("operator_sessions_token_idx").on(table.tokenHash),
  index("operator_sessions_user_idx").on(table.userId),
  index("operator_sessions_expiry_idx").on(table.expiresAt),
]);

export const installationSettings = sqliteTable("installation_settings", {
  id: text("id").primaryKey(),
  publicBaseUrl: text("public_base_url").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const deviceCredentials = sqliteTable("device_credentials", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  enrollmentTokenId: text("enrollment_token_id").notNull().references(() => enrollmentTokens.id, { onDelete: "restrict" }),
  secretHash: text("secret_hash").notNull(),
  secretPrefix: text("secret_prefix").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
}, (table) => [
  uniqueIndex("device_credentials_secret_hash_idx").on(table.secretHash),
  uniqueIndex("device_credentials_enrollment_token_idx").on(table.enrollmentTokenId),
  index("device_credentials_device_idx").on(table.deviceId),
]);

export const deviceSessions = sqliteTable("device_sessions", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().references(() => deviceCredentials.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("CONNECTED"),
  connectedAt: integer("connected_at").notNull().default(sql`(unixepoch() * 1000)`),
  lastHeartbeatAt: integer("last_heartbeat_at").notNull().default(sql`(unixepoch() * 1000)`),
  disconnectedAt: integer("disconnected_at"),
  closeCode: integer("close_code"),
  closeReason: text("close_reason").notNull().default(""),
}, (table) => [
  index("device_sessions_device_time_idx").on(table.deviceId, table.connectedAt),
  index("device_sessions_state_heartbeat_idx").on(table.state, table.lastHeartbeatAt),
]);

export const deviceStateSnapshots = sqliteTable("device_state_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => deviceSessions.id, { onDelete: "set null" }),
  sequence: integer("sequence").notNull(),
  payloadJson: text("payload_json").notNull(),
  recordedAt: integer("recorded_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  uniqueIndex("device_state_snapshots_session_sequence_idx").on(table.sessionId, table.sequence),
  index("device_state_snapshots_device_time_idx").on(table.deviceId, table.recordedAt),
]);

export const deviceTelemetrySamples = sqliteTable("device_telemetry_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  pinId: text("pin_id").notNull(),
  sequence: integer("sequence"),
  rawValue: real("raw_value").notNull(),
  voltageValue: real("voltage_value").notNull(),
  engineeringValue: real("engineering_value").notNull(),
  engineeringUnit: text("engineering_unit").notNull().default("V"),
  recordedAt: integer("recorded_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index("device_telemetry_pin_time_idx").on(table.deviceId, table.pinId, table.recordedAt),
  index("device_telemetry_device_time_idx").on(table.deviceId, table.recordedAt),
]);

export const deviceSafeStateRuns = sqliteTable("device_safe_state_runs", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  actor: text("actor").notNull().default("owner"),
  status: text("status").notNull().default("QUEUED"),
  targetCount: integer("target_count").notNull(),
  requestedAt: integer("requested_at").notNull().default(sql`(unixepoch() * 1000)`),
  completedAt: integer("completed_at"),
}, (table) => [index("device_safe_state_runs_device_time_idx").on(table.deviceId, table.requestedAt)]);

export const automationRules = sqliteTable("automation_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  mode: text("mode").notNull().default("DISABLED"),
  revision: integer("revision").notNull().default(1),
  mutationId: text("mutation_id").notNull().default(""),
  permissionScope: text("permission_scope").notNull().default("OWNER_ONLY"),
  actionScope: text("action_scope").notNull().default("SIMULATOR_ONLY"),
  approvedRevision: integer("approved_revision"),
  approvedBy: text("approved_by"),
  approvedAt: integer("approved_at"),
  cooldownMs: integer("cooldown_ms").notNull().default(60_000),
  rateLimitCount: integer("rate_limit_count").notNull().default(10),
  rateLimitWindowMs: integer("rate_limit_window_ms").notNull().default(3_600_000),
  maxChainDepth: integer("max_chain_depth").notNull().default(2),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  archivedAt: integer("archived_at"),
}, (table) => [
  index("automation_rules_mode_updated_idx").on(table.mode, table.updatedAt),
  index("automation_rules_archived_idx").on(table.archivedAt),
]);

export const automationTriggers = sqliteTable("automation_triggers", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => automationRules.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  sourceDeviceId: text("source_device_id").references(() => devices.id, { onDelete: "set null" }),
  sourcePinId: text("source_pin_id"),
  comparator: text("comparator"),
  thresholdValue: real("threshold_value"),
  hysteresis: real("hysteresis").notNull().default(0),
  holdForMs: integer("hold_for_ms").notNull().default(0),
  maxSampleAgeMs: integer("max_sample_age_ms").notNull().default(30_000),
  sourceUnit: text("source_unit"),
  sourceConfigurationVersion: integer("source_configuration_version"),
  intervalMs: integer("interval_ms"),
  scheduleMinuteUtc: integer("schedule_minute_utc"),
  scheduleDaysMask: integer("schedule_days_mask"),
  scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
  lastSourceEventKey: text("last_source_event_key"),
  lastObservedValue: real("last_observed_value"),
  conditionSinceAt: integer("condition_since_at"),
  armed: integer("armed", { mode: "boolean" }).notNull().default(true),
  nextDueAt: integer("next_due_at"),
  lastEvaluatedAt: integer("last_evaluated_at"),
  lastFiredAt: integer("last_fired_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  uniqueIndex("automation_triggers_rule_idx").on(table.ruleId),
  index("automation_triggers_source_idx").on(table.sourceDeviceId, table.sourcePinId),
  index("automation_triggers_due_idx").on(table.kind, table.nextDueAt),
]);

export const automationActions = sqliteTable("automation_actions", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => automationRules.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  targetDeviceId: text("target_device_id").references(() => devices.id, { onDelete: "set null" }),
  targetPinId: text("target_pin_id").notNull(),
  commandKind: text("command_kind").notNull(),
  requestedValue: real("requested_value").notNull(),
  targetConfigurationVersion: integer("target_configuration_version"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  uniqueIndex("automation_actions_rule_position_idx").on(table.ruleId, table.position),
  index("automation_actions_target_idx").on(table.targetDeviceId, table.targetPinId),
]);

export const automationExecutions = sqliteTable("automation_executions", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => automationRules.id, { onDelete: "restrict" }),
  triggerId: text("trigger_id").references(() => automationTriggers.id, { onDelete: "set null" }),
  ruleRevision: integer("rule_revision").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceEventKey: text("source_event_key").notNull(),
  executionMode: text("execution_mode").notNull(),
  status: text("status").notNull(),
  actor: text("actor").notNull(),
  rootExecutionId: text("root_execution_id"),
  parentExecutionId: text("parent_execution_id"),
  chainDepth: integer("chain_depth").notNull().default(0),
  triggerValue: real("trigger_value"),
  triggerRecordedAt: integer("trigger_recorded_at"),
  conditionSinceAt: integer("condition_since_at"),
  matched: integer("matched", { mode: "boolean" }).notNull().default(false),
  reason: text("reason").notNull().default(""),
  requestedAt: integer("requested_at").notNull().default(sql`(unixepoch() * 1000)`),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
}, (table) => [
  uniqueIndex("automation_executions_rule_event_idx").on(table.ruleId, table.sourceEventKey),
  index("automation_executions_rule_time_idx").on(table.ruleId, table.requestedAt),
  index("automation_executions_status_time_idx").on(table.status, table.requestedAt),
  index("automation_executions_root_idx").on(table.rootExecutionId),
]);

export const gpioCommands = sqliteTable("gpio_commands", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  pinId: text("pin_id").notNull(),
  kind: text("kind").notNull(),
  origin: text("origin").notNull().default("OPERATOR"),
  safeStateRunId: text("safe_state_run_id").references(() => deviceSafeStateRuns.id, { onDelete: "set null" }),
  automationRuleId: text("automation_rule_id").references(() => automationRules.id, { onDelete: "set null" }),
  automationRuleRevision: integer("automation_rule_revision"),
  automationActionId: text("automation_action_id").references(() => automationActions.id, { onDelete: "set null" }),
  automationExecutionId: text("automation_execution_id").references(() => automationExecutions.id, { onDelete: "set null" }),
  requestedMode: text("requested_mode"),
  requestedValue: real("requested_value"),
  status: text("status").notNull().default("QUEUED"),
  actor: text("actor").notNull().default("owner"),
  requestedAt: integer("requested_at").notNull().default(sql`(unixepoch() * 1000)`),
  deadlineAt: integer("deadline_at").notNull(),
  deliveredAt: integer("delivered_at"),
  completedAt: integer("completed_at"),
  sessionId: text("session_id").references(() => deviceSessions.id, { onDelete: "set null" }),
  confirmedMode: text("confirmed_mode"),
  confirmedValue: real("confirmed_value"),
  deviceTimestampMs: integer("device_timestamp_ms"),
  latencyMs: integer("latency_ms"),
  error: text("error").notNull().default(""),
}, (table) => [
  index("gpio_commands_device_time_idx").on(table.deviceId, table.requestedAt),
  index("gpio_commands_device_status_idx").on(table.deviceId, table.status),
  index("gpio_commands_status_deadline_idx").on(table.status, table.deadlineAt),
  index("gpio_commands_session_idx").on(table.sessionId),
  index("gpio_commands_safe_state_run_idx").on(table.safeStateRunId),
  index("gpio_commands_automation_rule_status_idx").on(table.automationRuleId, table.status),
  index("gpio_commands_automation_execution_idx").on(table.automationExecutionId),
]);

export const automationActionRuns = sqliteTable("automation_action_runs", {
  id: text("id").primaryKey(),
  executionId: text("execution_id").notNull().references(() => automationExecutions.id, { onDelete: "cascade" }),
  actionId: text("action_id").references(() => automationActions.id, { onDelete: "set null" }),
  position: integer("position").notNull(),
  targetDeviceId: text("target_device_id").notNull(),
  targetPinId: text("target_pin_id").notNull(),
  commandKind: text("command_kind").notNull(),
  requestedValue: real("requested_value").notNull(),
  status: text("status").notNull().default("PLANNED"),
  gpioCommandId: text("gpio_command_id").references(() => gpioCommands.id, { onDelete: "set null" }),
  error: text("error").notNull().default(""),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
}, (table) => [
  uniqueIndex("automation_action_runs_execution_position_idx").on(table.executionId, table.position),
  uniqueIndex("automation_action_runs_command_idx").on(table.gpioCommandId),
  index("automation_action_runs_status_time_idx").on(table.status, table.startedAt),
]);

export const deviceAgentLogs = sqliteTable("device_agent_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => deviceSessions.id, { onDelete: "set null" }),
  level: text("level").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull().default(""),
  deviceUptimeMs: integer("device_uptime_ms"),
  recordedAt: integer("recorded_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  index("device_agent_logs_device_time_idx").on(table.deviceId, table.recordedAt),
  index("device_agent_logs_level_time_idx").on(table.level, table.recordedAt),
]);

export const hardwareTestRuns = sqliteTable("hardware_test_runs", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("RUNNING"),
  agentVersion: text("agent_version").notNull(),
  validatedConfigurationVersion: integer("validated_configuration_version").notNull().default(0),
  validatedFirmwareVersion: text("validated_firmware_version"),
  fixture: text("fixture").notNull().default("D7 output to D2 input loopback"),
  targetCycles: integer("target_cycles").notNull().default(1000),
  completedCycles: integer("completed_cycles").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  operator: text("operator").notNull().default("owner"),
  notes: text("notes").notNull().default(""),
  startedAt: integer("started_at").notNull().default(sql`(unixepoch() * 1000)`),
  completedAt: integer("completed_at"),
}, (table) => [index("hardware_test_runs_device_time_idx").on(table.deviceId, table.startedAt)]);

export const hardwareTestSteps = sqliteTable("hardware_test_steps", {
  runId: text("run_id").notNull().references(() => hardwareTestRuns.id, { onDelete: "cascade" }),
  stepKey: text("step_key").notNull(),
  status: text("status").notNull().default("PENDING"),
  observation: text("observation").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
}, (table) => [
  primaryKey({ columns: [table.runId, table.stepKey] }),
  index("hardware_test_steps_run_status_idx").on(table.runId, table.status),
]);
