export const PROTOCOL_VERSION = 1 as const;

export type DeviceAuthenticate = {
  type: "device.authenticate";
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  credential: string;
};

export type Heartbeat = {
  type: "device.heartbeat";
  sequence: number;
  rssiDbm?: number;
  ipAddress?: string;
  agentVersion?: string;
  firmwareVersion?: string;
  localFailsafe?: { mode: "SAFE_INPUT_BOOT" | "LINK_LOSS_SAFE_STATE"; timeoutMs?: number | null };
};

export type DeviceSnapshot = {
  type: "device.snapshot";
  sequence: number;
  pins: Array<{ pinId: string; value: number; mode?: "INPUT" | "INPUT_PULLUP" | "OUTPUT" | "PWM" | "DAC" | "ANALOG" }>;
};

export type DeviceCommandPoll = {
  type: "device.command.poll";
};

export type GpioCommand = {
  type: "gpio.command";
  commandId: string;
  kind: "WRITE" | "WRITE_PWM" | "WRITE_DAC" | "SET_MODE";
  pinId: string;
  requestedMode: "INPUT" | "INPUT_PULLUP" | "OUTPUT" | "PWM" | "DAC" | "ANALOG" | null;
  requestedValue: number | null;
  deadlineAt: number;
};

export type GpioAcknowledgment = {
  type: "gpio.ack";
  commandId: string;
  pinId: string;
  confirmedMode: "INPUT" | "INPUT_PULLUP" | "OUTPUT" | "PWM" | "DAC" | "ANALOG";
  confirmedValue: number;
  deviceTimestampMs?: number;
  error?: string;
};

export type DeviceLog = {
  type: "device.log";
  level: "INFO" | "WARN" | "ERROR";
  code: string;
  message?: string;
  deviceUptimeMs?: number;
};

export type DeviceMessage = DeviceAuthenticate | Heartbeat | DeviceSnapshot | DeviceCommandPoll | GpioAcknowledgment | DeviceLog;
export type ServerMessage =
  | { type: "device.authenticated"; protocolVersion: typeof PROTOCOL_VERSION; sessionId: string; serverTime: number; heartbeatIntervalMs: number; sessionTimeoutMs: number }
  | { type: "device.heartbeat.ack"; sequence: number | null; serverTime: number }
  | { type: "device.snapshot.ack"; sequence: number; recordedAt: number }
  | GpioCommand
  | { type: "gpio.ack.accepted"; commandId: string; status: "ACKNOWLEDGED" | "FAILED"; serverTime: number }
  | { type: "device.log.ack"; logId: number; recordedAt: number }
  | { type: "device.error"; code: string; detail?: string; messageType?: string | null };
