import type { DatabaseBinding } from "@/db";
import { recordAgentLog } from "@/lib/agent-server";
import { continueAutomationFromCommand, evaluateAutomationForDevice, refreshAutomationExecutionForCommand, runDueAutomationCycle } from "@/lib/automation-server";
import {
  authenticateDevice,
  closeDeviceSession,
  credentialIsActive,
  openDeviceSession,
  recordDeviceSnapshot,
  sessionIsConnected,
  touchDeviceHeartbeat,
} from "@/lib/device-auth";
import { acknowledgeGpioCommand, claimNextGpioCommand } from "@/lib/gpio-server";
import { HEARTBEAT_INTERVAL_MS, SESSION_TIMEOUT_MS, TRANSPORT_PROTOCOL_VERSION } from "@/lib/device-model";

export type DeviceTransportSocket = {
  send(payload: string): void;
  close(code: number, reason: string): void;
  onMessage(listener: (payload: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: () => void): void;
};

export type BackgroundTaskContext = { waitUntil(promise: Promise<unknown>): void };
type SocketMessage = Record<string, unknown> & { type?: string };

function send(socket: DeviceTransportSocket, payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload));
}

export function attachDeviceSocket(socket: DeviceTransportSocket, db: DatabaseBinding, ctx: BackgroundTaskContext) {
  let deviceId: string | null = null;
  let credentialId: string | null = null;
  let sessionId: string | null = null;
  let closed = false;
  let queue = Promise.resolve();
  let sessionDeadline: ReturnType<typeof setTimeout> | null = null;

  function armSessionDeadline() {
    if (sessionDeadline) clearTimeout(sessionDeadline);
    sessionDeadline = setTimeout(() => socket.close(4000, "Heartbeat timeout"), SESSION_TIMEOUT_MS);
    sessionDeadline.unref?.();
  }

  const authDeadline = setTimeout(() => {
    if (!sessionId) socket.close(4001, "Authentication timeout");
  }, 5_000);
  authDeadline.unref?.();

  async function processMessage(raw: string) {
    if (!raw || Buffer.byteLength(raw, "utf8") > 32_768) {
      socket.close(4002, "Invalid message");
      return;
    }
    let message: SocketMessage;
    try { message = JSON.parse(raw) as SocketMessage; }
    catch { socket.close(4002, "Invalid JSON"); return; }

    if (!sessionId) {
      if (message.type !== "device.authenticate" || typeof message.deviceId !== "string" || typeof message.credential !== "string") {
        socket.close(4001, "Authenticate first");
        return;
      }
      if (Number(message.protocolVersion) !== TRANSPORT_PROTOCOL_VERSION) {
        socket.close(4004, "Protocol version mismatch");
        return;
      }
      const authenticated = await authenticateDevice(db, message.deviceId.slice(0, 80), message.credential);
      if (!authenticated) { socket.close(4003, "Credential rejected"); return; }
      deviceId = authenticated.deviceId;
      credentialId = authenticated.id;
      const session = await openDeviceSession(db, deviceId, credentialId);
      sessionId = session.id;
      clearTimeout(authDeadline);
      armSessionDeadline();
      send(socket, {
        type: "device.authenticated",
        protocolVersion: TRANSPORT_PROTOCOL_VERSION,
        sessionId,
        serverTime: Date.now(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        sessionTimeoutMs: SESSION_TIMEOUT_MS,
      });
      return;
    }

    if (!deviceId || !credentialId || !(await credentialIsActive(db, credentialId))) {
      socket.close(4003, "Credential revoked");
      return;
    }
    if (!(await sessionIsConnected(db, sessionId, deviceId, credentialId))) {
      socket.close(4000, "Session expired");
      return;
    }

    if (message.type === "device.heartbeat") {
      const serverTime = await touchDeviceHeartbeat(db, sessionId, deviceId, message);
      armSessionDeadline();
      send(socket, { type: "device.heartbeat.ack", sequence: message.sequence ?? null, serverTime });
      ctx.waitUntil(runDueAutomationCycle(db, serverTime));
      return;
    }

    if (message.type === "device.snapshot") {
      const result = await recordDeviceSnapshot(db, sessionId, deviceId, Number(message.sequence), message);
      armSessionDeadline();
      send(socket, { type: "device.snapshot.ack", sequence: message.sequence, recordedAt: result.recordedAt });
      ctx.waitUntil(evaluateAutomationForDevice(db, deviceId, result.recordedAt));
      return;
    }

    if (message.type === "device.log") {
      const log = await recordAgentLog(db, {
        deviceId,
        sessionId,
        level: message.level,
        code: message.code,
        message: message.message,
        deviceUptimeMs: message.deviceUptimeMs,
      });
      armSessionDeadline();
      send(socket, { type: "device.log.ack", logId: log.id, recordedAt: log.recordedAt });
      return;
    }

    if (message.type === "device.command.poll") {
      const command = await claimNextGpioCommand(db, deviceId, sessionId);
      if (command) {
        send(socket, {
          type: "gpio.command",
          commandId: command.id,
          kind: command.kind,
          pinId: command.pinId,
          requestedMode: command.requestedMode,
          requestedValue: command.requestedValue,
          deadlineAt: command.deadlineAt,
        });
      }
      ctx.waitUntil(runDueAutomationCycle(db));
      return;
    }

    if (message.type === "gpio.ack") {
      if (typeof message.commandId !== "string" || typeof message.pinId !== "string" ||
        typeof message.confirmedMode !== "string" || typeof message.confirmedValue !== "number") {
        throw new Error("Invalid GPIO acknowledgment");
      }
      const command = await acknowledgeGpioCommand(db, {
        deviceId,
        sessionId,
        commandId: message.commandId,
        pinId: message.pinId,
        confirmedMode: message.confirmedMode,
        confirmedValue: message.confirmedValue,
        deviceTimestampMs: typeof message.deviceTimestampMs === "number" ? message.deviceTimestampMs : undefined,
        error: typeof message.error === "string" ? message.error.slice(0, 120) : undefined,
      });
      await refreshAutomationExecutionForCommand(db, message.commandId);
      if (command?.status === "ACKNOWLEDGED") ctx.waitUntil(continueAutomationFromCommand(db, message.commandId));
      send(socket, { type: "gpio.ack.accepted", commandId: message.commandId, status: command?.status ?? "FAILED", serverTime: Date.now() });
      return;
    }

    send(socket, { type: "device.error", code: "UNSUPPORTED_MESSAGE", messageType: message.type ?? null });
  }

  socket.onMessage((payload) => {
    queue = queue.then(() => processMessage(payload)).catch((error) => {
      send(socket, { type: "device.error", code: "MESSAGE_REJECTED", detail: error instanceof Error ? error.message : "Message rejected" });
    });
    ctx.waitUntil(queue);
  });

  function finish(code: number, reason: string) {
    clearTimeout(authDeadline);
    if (sessionDeadline) clearTimeout(sessionDeadline);
    if (closed) return;
    closed = true;
    if (sessionId && deviceId) ctx.waitUntil(closeDeviceSession(db, sessionId, deviceId, code, reason));
  }

  socket.onClose((code, reason) => finish(code || 1000, reason || "Socket closed"));
  socket.onError(() => finish(1011, "Socket error"));
}
