export const APP_VERSION = "0.10.0" as const;
export const DATABASE_SCHEMA_VERSION = 9 as const;
export const TRANSPORT_PROTOCOL_VERSION = 1 as const;
export const HEARTBEAT_INTERVAL_MS = 10_000 as const;
export const SESSION_TIMEOUT_MS = 35_000 as const;
export const GPIO_COMMAND_TIMEOUT_MS = 5_000 as const;
export const TELEMETRY_MIN_INTERVAL_MS = 1_000 as const;
export const TELEMETRY_RETENTION_PER_PIN = 720 as const;
export const AUTOMATION_EXECUTION_RETENTION = 500 as const;
export const AUTOMATION_MIN_LIVE_COOLDOWN_MS = 5_000 as const;
export const AUTOMATION_MAX_ACTIONS = 1 as const;
export const DEVICE_STATES = ["ONLINE", "OFFLINE", "RECONNECTING", "UNKNOWN"] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];
export type DeviceKind = "SIMULATED" | "PHYSICAL";
export type PinMode = "INPUT" | "INPUT_PULLUP" | "OUTPUT" | "PWM" | "DAC" | "ANALOG";
export type FirmwareFailsafeMode = "NOT_REPORTED" | "SAFE_INPUT_BOOT" | "LINK_LOSS_SAFE_STATE";

export type DeviceRecord = {
  id: string; name: string; boardProfileId: string; boardName: string;
  kind: DeviceKind; connectionState: DeviceState; groupId: string | null;
  groupName: string | null; agentVersion: string | null; firmwareVersion: string | null;
  rssiDbm: number | null; ipAddress: string | null; lastSeenAt: number | null;
  lastConnectedAt: number | null; lastDisconnectedAt: number | null;
  simulated: boolean; maintenanceMode: boolean; monitorOnly: boolean; automationArmed: boolean; controlReady: boolean;
  firmwareFailsafeMode: FirmwareFailsafeMode; firmwareFailsafeTimeoutMs: number | null;
  firmwareFailsafeReportedAt: number | null; configurationVersion: number;
  createdAt: number; updatedAt: number;
};

export type DevicePin = {
  deviceId: string; pinId: string; label: string; mode: PinMode;
  confirmedValue: number | null; confirmedRawValue: number | null; sampledAt: number | null;
  logicalLowLabel: string | null;
  logicalHighLabel: string | null; engineeringUnit: string | null;
  scaleInputLow: number | null; scaleOutputLow: number | null;
  scaleInputHigh: number | null; scaleOutputHigh: number | null;
  serverSafeValue: number | null; capability: string;
  pendingCommandId: string | null; pendingCommandKind: GpioCommandKind | null;
  requestedMode: PinMode | null; requestedValue: number | null;
  pendingCommandStatus: Extract<GpioCommandStatus, "QUEUED" | "DELIVERED"> | null;
  requestedAt: number | null; commandDeadlineAt: number | null;
};

export type DeviceGroup = { id: string; name: string; description: string; deviceCount: number };
export type ConnectionEvent = { id: number; state: DeviceState; reason: string; occurredAt: number };
export type EnrollmentTokenRecord = {
  id: string; tokenPrefix: string; boardProfileId: string; deviceName: string;
  expiresAt: number; createdAt: number; usedAt: number | null;
  usedByDeviceId: string | null; revokedAt: number | null;
};
export type DeviceCredentialRecord = {
  id: string; deviceId: string; secretPrefix: string; createdAt: number;
  lastUsedAt: number | null; revokedAt: number | null;
};
export type DeviceSessionRecord = {
  id: string; deviceId: string; credentialId: string; state: "CONNECTED" | "CLOSED" | "TIMED_OUT";
  connectedAt: number; lastHeartbeatAt: number; disconnectedAt: number | null;
  closeCode: number | null; closeReason: string;
};
export type DeviceStateSnapshot = {
  id: number; deviceId: string; sessionId: string | null; sequence: number;
  payload: Record<string, unknown>; recordedAt: number;
};
export type TelemetrySample = {
  id: number; deviceId: string; pinId: string; sequence: number | null;
  rawValue: number; voltageValue: number; engineeringValue: number;
  engineeringUnit: string; recordedAt: number;
};
export type GpioCommandKind = "WRITE" | "WRITE_PWM" | "WRITE_DAC" | "SET_MODE";
export type GpioCommandStatus = "QUEUED" | "DELIVERED" | "ACKNOWLEDGED" | "FAILED" | "TIMED_OUT";
export type GpioCommandRecord = {
  id: string; deviceId: string; pinId: string; kind: GpioCommandKind;
  origin: "OPERATOR" | "SERVER_SAFE_STATE" | "AUTOMATION"; safeStateRunId: string | null;
  automationRuleId: string | null; automationRuleRevision: number | null;
  automationActionId: string | null; automationExecutionId: string | null;
  requestedMode: PinMode | null; requestedValue: number | null;
  status: GpioCommandStatus; actor: string; requestedAt: number;
  deadlineAt: number; deliveredAt: number | null; completedAt: number | null;
  sessionId: string | null; confirmedMode: PinMode | null;
  confirmedValue: number | null; deviceTimestampMs: number | null;
  latencyMs: number | null; error: string;
};
export type SafeStateRunStatus = "QUEUED" | "RUNNING" | "ACKNOWLEDGED" | "FAILED" | "TIMED_OUT";
export type SafeStateRunRecord = {
  id: string; deviceId: string; actor: string; status: SafeStateRunStatus;
  targetCount: number; acknowledgedCount: number; failedCount: number;
  requestedAt: number; completedAt: number | null;
};
export type AgentLogLevel = "INFO" | "WARN" | "ERROR";
export type AgentLogRecord = {
  id: number; deviceId: string; sessionId: string | null;
  level: AgentLogLevel; code: string; message: string;
  deviceUptimeMs: number | null; recordedAt: number;
};

export type AutomationRuleMode = "DISABLED" | "DRY_RUN" | "LIVE";
export type AutomationActionScope = "SIMULATOR_ONLY" | "PHYSICAL_CONTROL";
export type AutomationTriggerKind = "THRESHOLD" | "INTERVAL" | "SCHEDULE";
export type AutomationComparator = "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NE";
export type AutomationExecutionStatus =
  | "NO_MATCH" | "ARMED" | "RESET" | "DRY_RUN" | "QUEUED" | "RUNNING"
  | "ACKNOWLEDGED" | "PARTIAL" | "BLOCKED" | "FAILED" | "TIMED_OUT"
  | "COOLDOWN" | "RATE_LIMITED" | "LOOP_BLOCKED" | "CANCELLED";
export type AutomationActionRunStatus =
  | "PLANNED" | "DRY_RUN" | "QUEUED" | "DELIVERED" | "ACKNOWLEDGED"
  | "FAILED" | "TIMED_OUT" | "CANCELLED";

export type AutomationTriggerRecord = {
  id: string; ruleId: string; kind: AutomationTriggerKind;
  sourceDeviceId: string | null; sourcePinId: string | null;
  comparator: AutomationComparator | null; thresholdValue: number | null;
  hysteresis: number; holdForMs: number; maxSampleAgeMs: number;
  sourceUnit: string | null; sourceConfigurationVersion: number | null;
  intervalMs: number | null; scheduleMinuteUtc: number | null;
  scheduleDaysMask: number | null; scheduleTimezone: "UTC";
  lastSourceEventKey: string | null; lastObservedValue: number | null;
  conditionSinceAt: number | null; armed: boolean; nextDueAt: number | null;
  lastEvaluatedAt: number | null; lastFiredAt: number | null;
  createdAt: number; updatedAt: number;
};

export type AutomationActionRecord = {
  id: string; ruleId: string; position: number; targetDeviceId: string | null;
  targetPinId: string; commandKind: Extract<GpioCommandKind, "WRITE" | "WRITE_PWM" | "WRITE_DAC">;
  requestedValue: number; targetConfigurationVersion: number | null;
  createdAt: number; updatedAt: number;
};

export type AutomationRuleRecord = {
  id: string; name: string; description: string; mode: AutomationRuleMode;
  revision: number; permissionScope: "OWNER_ONLY"; actionScope: AutomationActionScope;
  approvedRevision: number | null; approvedBy: string | null; approvedAt: number | null;
  cooldownMs: number; rateLimitCount: number; rateLimitWindowMs: number;
  maxChainDepth: number; createdBy: string; updatedBy: string;
  createdAt: number; updatedAt: number; archivedAt: number | null;
  trigger: AutomationTriggerRecord; actions: AutomationActionRecord[];
  suspensionReasons: string[];
};

export type AutomationActionRunRecord = {
  id: string; executionId: string; actionId: string | null; position: number;
  targetDeviceId: string; targetPinId: string;
  commandKind: AutomationActionRecord["commandKind"]; requestedValue: number;
  status: AutomationActionRunStatus; gpioCommandId: string | null; error: string;
  startedAt: number | null; completedAt: number | null;
};

export type AutomationExecutionRecord = {
  id: string; ruleId: string; ruleName: string; triggerId: string | null;
  ruleRevision: number; sourceKind: AutomationTriggerKind | "MANUAL" | "DRY_RUN";
  sourceEventKey: string; executionMode: "DRY_RUN" | "LIVE";
  status: AutomationExecutionStatus; actor: string;
  rootExecutionId: string | null; parentExecutionId: string | null; chainDepth: number;
  triggerValue: number | null; triggerRecordedAt: number | null;
  conditionSinceAt: number | null; matched: boolean; reason: string;
  requestedAt: number; startedAt: number | null; completedAt: number | null;
  actions: AutomationActionRunRecord[];
};

export type AutomationRuleDraft = {
  name: string; description?: string; actionScope?: AutomationActionScope;
  trigger: {
    kind: AutomationTriggerKind; sourceDeviceId?: string; sourcePinId?: string;
    comparator?: AutomationComparator; thresholdValue?: number; hysteresis?: number;
    holdForMs?: number; maxSampleAgeMs?: number; intervalMs?: number;
    scheduleMinuteUtc?: number; scheduleDaysMask?: number; scheduleTimezone?: "UTC";
  };
  actions: Array<{
    targetDeviceId: string; targetPinId: string;
    commandKind: AutomationActionRecord["commandKind"]; requestedValue: number;
  }>;
  cooldownMs?: number; rateLimitCount?: number; rateLimitWindowMs?: number;
  maxChainDepth?: number;
};
export const HIL_STEP_KEYS = [
  "ENROLLMENT", "AUTHENTICATION", "SAFE_BOOT", "D7_HIGH_ELECTRICAL",
  "D2_HIGH_SNAPSHOT", "D7_LOW_ELECTRICAL", "D2_LOW_SNAPSHOT",
  "CYCLE_TEST", "WIFI_RECOVERY", "SERVER_RECOVERY", "BOARD_RECOVERY",
  "BROWSER_RECOVERY", "FRESH_SNAPSHOT", "SAFE_LOGS",
] as const;
export type HilStepKey = (typeof HIL_STEP_KEYS)[number];
export type HilStepStatus = "PENDING" | "PASSED" | "FAILED";
export type HilRunStatus = "RUNNING" | "PASSED" | "FAILED" | "ABORTED";
export type HilStepRecord = {
  runId: string; stepKey: HilStepKey; status: HilStepStatus;
  observation: string; updatedAt: number;
};
export type HilRunRecord = {
  id: string; deviceId: string; status: HilRunStatus; agentVersion: string;
  validatedConfigurationVersion: number; validatedFirmwareVersion: string | null;
  fixture: string; targetCycles: number; completedCycles: number;
  failureCount: number; operator: string; notes: string;
  startedAt: number; completedAt: number | null; steps: HilStepRecord[];
};
export type TransportBundle = {
  device: DeviceRecord; pins: DevicePin[]; events: ConnectionEvent[];
  credentials: DeviceCredentialRecord[]; sessions: DeviceSessionRecord[];
  snapshots: DeviceStateSnapshot[]; commands: GpioCommandRecord[];
  logs: AgentLogRecord[];
};

export function isDeviceState(value: unknown): value is DeviceState {
  return typeof value === "string" && DEVICE_STATES.includes(value as DeviceState);
}
