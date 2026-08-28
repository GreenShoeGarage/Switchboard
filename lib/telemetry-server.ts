import type { DatabaseBinding, DatabaseStatement } from "@/db";
import { getBoardProfile } from "@/lib/board-profiles";
import { TELEMETRY_MIN_INTERVAL_MS, TELEMETRY_RETENTION_PER_PIN, type DevicePin, type TelemetrySample } from "@/lib/device-model";

type Row = Record<string, unknown>;
type AnalogSample = {
  deviceId: string; pinId: string; sequence?: number | null; rawValue: number;
  voltageValue: number; engineeringValue: number; engineeringUnit: string; recordedAt: number;
  acceptedSnapshot?: { sessionId: string; sequence: number };
};

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function analogLimits(boardProfileId: string) {
  const profile = getBoardProfile(boardProfileId);
  if (!profile) throw new Error("Board profile is unavailable");
  const bits = Math.round(finiteNumber(profile.electrical.adcMaximumResolutionBits, 10));
  const referenceVolts = finiteNumber(profile.electrical.logicVoltageVolts, 5);
  return { bits, maximumRaw: (2 ** bits) - 1, referenceVolts };
}

export function scaleAnalogRaw(boardProfileId: string, pin: Pick<DevicePin, "engineeringUnit" | "scaleInputLow" | "scaleOutputLow" | "scaleInputHigh" | "scaleOutputHigh">, rawValue: number) {
  const { bits, maximumRaw, referenceVolts } = analogLimits(boardProfileId);
  if (!Number.isInteger(rawValue) || rawValue < 0 || rawValue > maximumRaw) throw new Error(`Analog sample must be a ${bits}-bit integer`);
  const voltageValue = round((rawValue / maximumRaw) * referenceVolts);
  const calibrated = [pin.scaleInputLow, pin.scaleOutputLow, pin.scaleInputHigh, pin.scaleOutputHigh].every((value) => typeof value === "number" && Number.isFinite(value));
  let engineeringValue = voltageValue;
  let engineeringUnit = "V";
  if (calibrated) {
    const inputLow = pin.scaleInputLow as number;
    const inputHigh = pin.scaleInputHigh as number;
    if (inputLow === inputHigh) throw new Error("Analog calibration input points must differ");
    engineeringValue = round((pin.scaleOutputLow as number) + ((voltageValue - inputLow) / (inputHigh - inputLow)) * ((pin.scaleOutputHigh as number) - (pin.scaleOutputLow as number)));
    engineeringUnit = pin.engineeringUnit?.trim().slice(0, 16) || "unit";
  }
  return { rawValue, voltageValue, engineeringValue, engineeringUnit, bits, maximumRaw, referenceVolts };
}

export function rawFromEngineering(boardProfileId: string, pin: Pick<DevicePin, "engineeringUnit" | "scaleInputLow" | "scaleOutputLow" | "scaleInputHigh" | "scaleOutputHigh">, engineeringValue: number) {
  const { maximumRaw, referenceVolts } = analogLimits(boardProfileId);
  const calibrated = [pin.scaleInputLow, pin.scaleOutputLow, pin.scaleInputHigh, pin.scaleOutputHigh].every((value) => typeof value === "number" && Number.isFinite(value));
  let voltage = engineeringValue;
  if (calibrated) {
    const outputLow = pin.scaleOutputLow as number;
    const outputHigh = pin.scaleOutputHigh as number;
    if (outputLow === outputHigh) throw new Error("Analog calibration output points must differ");
    voltage = (pin.scaleInputLow as number) + ((engineeringValue - outputLow) / (outputHigh - outputLow)) * ((pin.scaleInputHigh as number) - (pin.scaleInputLow as number));
  }
  return Math.max(0, Math.min(maximumRaw, Math.round((voltage / referenceVolts) * maximumRaw)));
}

export function telemetryStatements(db: DatabaseBinding, sample: AnalogSample): DatabaseStatement[] {
  const snapshotGuard = sample.acceptedSnapshot
    ? `AND EXISTS (SELECT 1 FROM device_state_snapshots WHERE device_id = ? AND session_id = ? AND sequence = ?)`
    : "";
  const guardBindings = sample.acceptedSnapshot
    ? [sample.deviceId, sample.acceptedSnapshot.sessionId, sample.acceptedSnapshot.sequence]
    : [];
  return [
    db.prepare(`INSERT INTO device_telemetry_samples
      (device_id, pin_id, sequence, raw_value, voltage_value, engineering_value, engineering_unit, recorded_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM device_telemetry_samples WHERE device_id = ? AND pin_id = ? AND recorded_at > ?
      ) ${snapshotGuard}`).bind(sample.deviceId, sample.pinId, sample.sequence ?? null, sample.rawValue, sample.voltageValue,
      sample.engineeringValue, sample.engineeringUnit.slice(0, 16), sample.recordedAt,
      sample.deviceId, sample.pinId, sample.recordedAt - TELEMETRY_MIN_INTERVAL_MS, ...guardBindings),
    db.prepare(`DELETE FROM device_telemetry_samples WHERE device_id = ? AND pin_id = ? AND id NOT IN (
      SELECT id FROM device_telemetry_samples WHERE device_id = ? AND pin_id = ?
      ORDER BY recorded_at DESC, id DESC LIMIT ?
    )`).bind(sample.deviceId, sample.pinId, sample.deviceId, sample.pinId, TELEMETRY_RETENTION_PER_PIN),
  ];
}

function mapSample(row: Row): TelemetrySample {
  return {
    id: Number(row.id), deviceId: String(row.device_id), pinId: String(row.pin_id),
    sequence: typeof row.sequence === "number" ? row.sequence : null,
    rawValue: Number(row.raw_value), voltageValue: Number(row.voltage_value),
    engineeringValue: Number(row.engineering_value), engineeringUnit: String(row.engineering_unit),
    recordedAt: Number(row.recorded_at),
  };
}

export async function listTelemetrySamples(db: DatabaseBinding, deviceId: string, pinId?: string | null, limit = 240) {
  const boundedLimit = Math.max(1, Math.min(TELEMETRY_RETENTION_PER_PIN, Math.round(limit)));
  const result = pinId
    ? await db.prepare(`SELECT * FROM device_telemetry_samples WHERE device_id = ? AND pin_id = ?
        ORDER BY recorded_at DESC, id DESC LIMIT ?`).bind(deviceId, pinId.slice(0, 8), boundedLimit).all<Row>()
    : await db.prepare(`SELECT * FROM device_telemetry_samples WHERE device_id = ?
        ORDER BY recorded_at DESC, id DESC LIMIT ?`).bind(deviceId, boundedLimit).all<Row>();
  return (result.results ?? []).map(mapSample);
}
