import { EventEmitter } from "node:events";

export class SwitchboardDeviceSimulator extends EventEmitter {
  constructor({ latencyMs = 84 } = {}) {
    super();
    this.online = false;
    this.latencyMs = latencyMs;
    this.sequence = 0;
    this.pins = new Map([["D7", { mode: "OUTPUT", value: 0 }], ["A0", { mode: "ANALOG", value: 41.5 }]]);
  }

  connect() { this.online = true; this.emit("online"); }
  disconnect() { this.online = false; this.emit("offline"); }

  heartbeat() {
    if (!this.online) return null;
    return { type: "device.heartbeat", protocol: 1, sequence: ++this.sequence, uptimeMs: process.uptime() * 1000, rssiDbm: -54 };
  }

  async command({ commandId, pin, value }) {
    if (!this.online) throw new Error("DEVICE_OFFLINE");
    if (!this.pins.has(pin)) throw new Error("UNKNOWN_PIN");
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const state = this.pins.get(pin); state.value = value;
    const acknowledgment = { type: "gpio.ack", commandId, pin, confirmedMode: state.mode, confirmedValue: state.value, deviceTimestampMs: Date.now() };
    this.emit("ack", acknowledgment);
    return acknowledgment;
  }
}
