import { classifyUnoR4Usb, UNO_R4_WIFI_PROFILE, UNO_R4_WIFI_USB_IDS, verifyFirmwareAsset } from "../firmware-manifest";
import { FlashError, type BoardIdentity, type FirmwarePackage, type Flasher, type FlashProgress } from "./types";

type PortInfo = { usbVendorId?: number; usbProductId?: number };
export type SerialPortRef = {
  getInfo?: () => PortInfo;
  open?: (options: { baudRate: number; bufferSize?: number }) => Promise<void>;
  close?: () => Promise<void>;
  readable?: ReadableStream<Uint8Array> | null;
  writable?: WritableStream<Uint8Array> | null;
};
type SerialNavigator = { requestPort(options: { filters: Array<{ usbVendorId: number; usbProductId: number }> }): Promise<SerialPortRef> };
export type AgentStatus = { type: "agent.identity" | "agent.status" | "agent.provisioned" | "agent.cleared"; agentVersion: string; boardProfile: string; configured: boolean; enrolled: boolean; wifiConnected: boolean; socketAuthenticated: boolean; deviceId: string; localFailsafeMode?: "SAFE_INPUT_BOOT" | "LINK_LOSS_SAFE_STATE"; localFailsafeTimeoutMs?: number | null };

function serialApi(): SerialNavigator | null {
  return typeof navigator === "undefined" ? null : ((navigator as Navigator & { serial?: SerialNavigator }).serial ?? null);
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function supportsWebSerial() {
  return typeof window !== "undefined" && window.isSecureContext && Boolean(serialApi());
}

export async function requestUnoR4Port(): Promise<SerialPortRef> {
  const serial = serialApi();
  if (!serial || typeof window === "undefined" || !window.isSecureContext) {
    throw new FlashError("BROWSER_UNSUPPORTED", "Use a secure page in desktop Chromium with Web Serial enabled.");
  }
  try {
    return await serial.requestPort({ filters: UNO_R4_WIFI_USB_IDS.map(({ vendorId, productId }) => ({ usbVendorId: vendorId, usbProductId: productId })) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") throw new FlashError("SERIAL_PERMISSION_DENIED", "No Arduino serial port was selected.");
    throw new FlashError("DEVICE_NOT_FOUND", `The Arduino serial port could not be opened: ${errorMessage(error)}`);
  }
}

function boardIdentity(port: SerialPortRef, agent?: AgentStatus): BoardIdentity {
  const info = port.getInfo?.() ?? {};
  const usbMode = classifyUnoR4Usb(info.usbVendorId, info.usbProductId);
  return {
    vendorId: info.usbVendorId, productId: info.usbProductId,
    profileId: usbMode === "unknown" ? undefined : UNO_R4_WIFI_PROFILE,
    displayName: usbMode === "runtime" ? "Arduino UNO R4 WiFi" : usbMode === "bootloader" ? "Arduino UNO R4 WiFi bootloader" : "Unsupported USB serial device",
    usbMode, agentVersion: agent?.agentVersion, configured: agent?.configured,
    enrolled: agent?.enrolled, deviceId: agent?.deviceId || undefined,
  };
}

export class UnoR4SerialSession {
  constructor(public readonly port: SerialPortRef) {}

  identity() { return boardIdentity(this.port); }

  async command(payload: Record<string, unknown>, expectedTypes: string[], timeoutMs = 3500): Promise<AgentStatus> {
    if (!this.port.open || !this.port.close) throw new FlashError("BROWSER_UNSUPPORTED", "The selected browser port is incomplete.");
    const identity = this.identity();
    if (identity.usbMode !== "runtime") throw new FlashError("BOARD_MISMATCH", "Select the UNO R4 WiFi runtime port for agent commands.");
    try {
      await this.port.open({ baudRate: 115200, bufferSize: 4096 });
      const writer = this.port.writable?.getWriter();
      const reader = this.port.readable?.getReader();
      if (!writer || !reader) throw new FlashError("SERIAL_PROTOCOL_ERROR", "The serial streams were not available.");
      try {
        await writer.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
        const decoder = new TextDecoder();
        let buffer = "";
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new FlashError("SERIAL_PROTOCOL_ERROR", "Timed out waiting for the agent.")), remaining); }),
          ]).catch(async (error) => { await reader.cancel().catch(() => undefined); throw error; });
          if (timeoutId) clearTimeout(timeoutId);
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as AgentStatus;
              if (expectedTypes.includes(parsed.type)) return parsed;
            } catch { /* Ignore Arduino boot and log lines that are not the requested response. */ }
          }
        }
        throw new FlashError("SERIAL_PROTOCOL_ERROR", "The agent did not return the requested response.");
      } finally {
        reader.releaseLock(); writer.releaseLock();
      }
    } catch (error) {
      if (error instanceof FlashError) throw error;
      throw new FlashError("PORT_IN_USE", `Serial session failed: ${errorMessage(error)}`);
    } finally {
      await this.port.close().catch(() => undefined);
    }
  }

  identifyAgent() { return this.command({ action: "identify" }, ["agent.identity", "agent.status"]); }
  readStatus() { return this.command({ action: "status" }, ["agent.status"]); }

  async provision(payload: Record<string, unknown>): Promise<void> {
    const response = await this.command(payload, ["agent.provisioned"], 5000);
    if (response.type !== "agent.provisioned") throw new FlashError("SERIAL_PROTOCOL_ERROR", "Provisioning was not acknowledged.");
  }

  async clearConfiguration(): Promise<void> {
    await this.command({ action: "clear" }, ["agent.cleared"], 3000);
  }

  async enterBootloader(): Promise<void> {
    if (!this.port.open || !this.port.close) throw new FlashError("BROWSER_UNSUPPORTED", "The selected browser port is incomplete.");
    if (this.identity().usbMode !== "runtime") throw new FlashError("BOARD_MISMATCH", "Select the UNO R4 WiFi runtime port before bootloader entry.");
    try {
      await this.port.open({ baudRate: 1200 });
      await this.port.close();
    } catch (error) {
      throw new FlashError("PROGRAMMING_MODE_FAILED", `1200-bps bootloader handoff failed: ${errorMessage(error)}`);
    }
  }
}

export function redactSerialText(value: string, limit = 512) {
  return value
    .replace(/(?:swenr_|swdev_)[A-Za-z0-9_-]+/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [REDACTED]")
    .replace(/("?(?:wifi[_-]?password|password|credential|token|api[_-]?key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/("?(?:wifi[_-]?password|password|credential|token|api[_-]?key)"?\s*[:=]\s*)'[^']*'/gi, "$1'[REDACTED]'")
    .replace(/\b(wifi[_-]?password|password|credential|token|api[_-]?key)\b"?\s*[:=]\s*[^,\s}]+/gi, "$1=[REDACTED]")
    .replace(/[\r\t]+/g, " ")
    .slice(0, limit);
}

export class UnoR4SerialConsole {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private running = false;
  private cleaned = false;

  constructor(public readonly port: SerialPortRef) {}

  identity() { return boardIdentity(this.port); }

  async connect(onLine: (line: string) => void, onClosed: (message: string) => void) {
    if (!this.port.open || !this.port.close) throw new FlashError("BROWSER_UNSUPPORTED", "The selected browser port is incomplete.");
    if (this.identity().usbMode !== "runtime") throw new FlashError("BOARD_MISMATCH", "Select the UNO R4 WiFi runtime port for the serial console.");
    try {
      await this.port.open({ baudRate: 115200, bufferSize: 4096 });
      this.writer = this.port.writable?.getWriter() ?? null;
      this.reader = this.port.readable?.getReader() ?? null;
      if (!this.writer || !this.reader) throw new FlashError("SERIAL_PROTOCOL_ERROR", "The serial streams were not available.");
      this.running = true;
      void this.readLoop(onLine).then(() => onClosed("Serial stream closed")).catch((error) => {
        if (this.running) onClosed(errorMessage(error));
      }).finally(() => void this.cleanup());
    } catch (error) {
      await this.cleanup();
      if (error instanceof FlashError) throw error;
      throw new FlashError("PORT_IN_USE", `Serial console failed: ${errorMessage(error)}`);
    }
  }

  private async readLoop(onLine: (line: string) => void) {
    const decoder = new TextDecoder();
    let buffer = "";
    while (this.running && this.reader) {
      const result = await this.reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 2_048) onLine("[OVERSIZED SERIAL LINE DISCARDED]");
        else if (line) onLine(redactSerialText(line));
        newlineIndex = buffer.indexOf("\n");
      }
      if (buffer.length > 2_048) {
        onLine("[OVERSIZED SERIAL LINE DISCARDED]");
        buffer = "";
      }
    }
    if (buffer) onLine(redactSerialText(buffer));
  }

  async sendLine(line: string) {
    if (!this.running || !this.writer) throw new FlashError("SERIAL_PROTOCOL_ERROR", "Connect the serial console first.");
    await this.writer.write(new TextEncoder().encode(`${line}\n`));
  }

  async disconnect() {
    this.running = false;
    await this.reader?.cancel().catch(() => undefined);
    await this.cleanup();
  }

  private async cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.running = false;
    try { this.reader?.releaseLock(); } catch { /* The stream may have released its lock while closing. */ }
    try { this.writer?.releaseLock(); } catch { /* The stream may have released its lock while closing. */ }
    this.reader = null;
    this.writer = null;
    await this.port.close?.().catch(() => undefined);
  }
}

/**
 * Transport adapter for browser serial selection. The UNO R4 flashing protocol
 * is intentionally not implemented until a hardware-verified strategy exists.
 */
export class WebSerialFlasher implements Flasher {
  constructor(private readonly port?: SerialPortRef) {}

  async detect() { return Boolean(this.port); }

  async identify(): Promise<BoardIdentity> {
    if (!this.port) throw new FlashError("DEVICE_NOT_FOUND", "Select a serial device first.");
    return boardIdentity(this.port);
  }

  async prepare(pkg: FirmwarePackage) {
    if (pkg.boardProfile !== UNO_R4_WIFI_PROFILE || this.port && boardIdentity(this.port).usbMode === "unknown") throw new FlashError("BOARD_MISMATCH", "Firmware and selected board do not match Arduino UNO R4 WiFi.");
    if (!pkg.bytes.byteLength) throw new FlashError("PACKAGE_UNAVAILABLE", "No compiled application binary is published for this candidate.");
    if (!pkg.verified || !await verifyFirmwareAsset(pkg.bytes, { url: "memory", sha256: pkg.sha256, bytes: pkg.bytes.byteLength })) throw new FlashError("VERIFICATION_FAILED", "Firmware bytes do not match the manifest SHA-256 digest.");
    if (!pkg.hardwareVerified || !pkg.hilRunId) throw new FlashError("PACKAGE_NOT_VERIFIED", "Browser erase/write stays locked until the physical HIL gate passes.");
  }

  async flash(pkg: FirmwarePackage, report: (progress: FlashProgress) => void): Promise<void> {
    void pkg; void report;
    throw new FlashError("UNSUPPORTED", "The verified Bossac write engine is not available in this release.");
  }

  async verify(pkg: FirmwarePackage): Promise<void> { await this.prepare(pkg); }
  async reboot(): Promise<void> {
    if (!this.port) throw new FlashError("DEVICE_NOT_FOUND", "Select a serial device first.");
    await new UnoR4SerialSession(this.port).enterBootloader();
  }
}
