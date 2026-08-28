import type { DevicePin, PinMode } from "@/lib/device-model";

export type PinConfigurationInput = {
  pinId?: string;
  label?: string;
  mode?: PinMode;
  logicalLowLabel?: string | null;
  logicalHighLabel?: string | null;
  engineeringUnit?: string | null;
  scaleInputLow?: number | null;
  scaleOutputLow?: number | null;
  scaleInputHigh?: number | null;
  scaleOutputHigh?: number | null;
  serverSafeValue?: number | null;
};

export type ResolvedPinConfiguration = Pick<DevicePin,
  "label" | "mode" | "logicalLowLabel" | "logicalHighLabel" | "engineeringUnit"
  | "scaleInputLow" | "scaleOutputLow" | "scaleInputHigh" | "scaleOutputHigh" | "serverSafeValue"
>;

export type CalibrationIssue = "INCOMPLETE" | "DEGENERATE" | "INPUT_OUT_OF_RANGE" | "UNIT_REQUIRED";
export type SafeStateIssue = "DIGITAL_RANGE" | "ANALOG_RANGE" | "NOT_OUTPUT";

const PIN_MODES = new Set<PinMode>(["INPUT", "INPUT_PULLUP", "OUTPUT", "PWM", "DAC", "ANALOG"]);
const OUTPUT_MODES = new Set<PinMode>(["OUTPUT", "PWM", "DAC"]);

function optionalText(value: unknown, current: string | null, maximumLength: number) {
  if (value === null) return null;
  return typeof value === "string" ? value.trim().slice(0, maximumLength) || null : current;
}

export function isPinMode(value: unknown): value is PinMode {
  return typeof value === "string" && PIN_MODES.has(value as PinMode);
}

export function resolvePinConfiguration(current: DevicePin, input: PinConfigurationInput): ResolvedPinConfiguration {
  return {
    label: typeof input.label === "string" ? input.label.trim().slice(0, 60) : current.label,
    mode: input.mode ?? current.mode,
    logicalLowLabel: optionalText(input.logicalLowLabel, current.logicalLowLabel, 40),
    logicalHighLabel: optionalText(input.logicalHighLabel, current.logicalHighLabel, 40),
    engineeringUnit: optionalText(input.engineeringUnit, current.engineeringUnit, 16),
    scaleInputLow: input.scaleInputLow === undefined ? current.scaleInputLow : input.scaleInputLow,
    scaleOutputLow: input.scaleOutputLow === undefined ? current.scaleOutputLow : input.scaleOutputLow,
    scaleInputHigh: input.scaleInputHigh === undefined ? current.scaleInputHigh : input.scaleInputHigh,
    scaleOutputHigh: input.scaleOutputHigh === undefined ? current.scaleOutputHigh : input.scaleOutputHigh,
    serverSafeValue: input.serverSafeValue === undefined ? current.serverSafeValue : input.serverSafeValue,
  };
}

export function calibrationIssue(configuration: ResolvedPinConfiguration): CalibrationIssue | null {
  const scale = [configuration.scaleInputLow, configuration.scaleOutputLow, configuration.scaleInputHigh, configuration.scaleOutputHigh];
  const cleared = scale.every((value) => value === null);
  const complete = scale.every((value) => typeof value === "number" && Number.isFinite(value));
  if (!cleared && !complete) return "INCOMPLETE";
  if (!complete) return null;
  if (configuration.scaleInputLow === configuration.scaleInputHigh || configuration.scaleOutputLow === configuration.scaleOutputHigh) return "DEGENERATE";
  if (configuration.scaleInputLow! < 0 || configuration.scaleInputLow! > 5 || configuration.scaleInputHigh! < 0 || configuration.scaleInputHigh! > 5) return "INPUT_OUT_OF_RANGE";
  if (!configuration.engineeringUnit) return "UNIT_REQUIRED";
  return null;
}

export function safeStateIssue(mode: PinMode, value: number | null): SafeStateIssue | null {
  if (value === null) return null;
  if (mode === "OUTPUT" && value !== 0 && value !== 1) return "DIGITAL_RANGE";
  if ((mode === "PWM" || mode === "DAC") && (!Number.isInteger(value) || value < 0 || value > 4095)) return "ANALOG_RANGE";
  return OUTPUT_MODES.has(mode) ? null : "NOT_OUTPUT";
}

export function calibrationWasRequested(input: PinConfigurationInput) {
  return [input.engineeringUnit, input.scaleInputLow, input.scaleOutputLow, input.scaleInputHigh, input.scaleOutputHigh]
    .some((value) => value !== undefined);
}
