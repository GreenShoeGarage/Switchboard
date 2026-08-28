"use client";

import { useState } from "react";
import { Activity, Gauge } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DevicePin, GpioCommandKind } from "@/lib/device-model";

type Props = {
  pin: DevicePin;
  disabled: boolean;
  onCommand(kind: Extract<GpioCommandKind, "WRITE_PWM" | "WRITE_DAC">, value: number): Promise<void>;
};

export function AnalogOutputControl({ pin, disabled, onCommand }: Props) {
  const [draft, setDraft] = useState(Math.max(0, Math.min(4095, Math.round(pin.confirmedValue ?? 0))));
  const isPwm = pin.mode === "PWM";
  const percent = (draft / 4095) * 100;
  const volts = (draft / 4095) * 5;
  const commandKind = isPwm ? "WRITE_PWM" : "WRITE_DAC";

  return <div className="analog-output-control">
    <div><span><Gauge /> {isPwm ? "PWM DUTY" : "DAC OUTPUT"}</span><strong>{isPwm ? `${percent.toFixed(1)}%` : `${volts.toFixed(3)} V`}</strong><small>{draft} / 4095 counts</small></div>
    <input type="range" min="0" max="4095" step="1" value={draft} onChange={(event) => setDraft(Number(event.target.value))} disabled={disabled} aria-label={`${pin.pinId} ${isPwm ? "PWM duty" : "DAC output"}`} />
    <div className="analog-presets">{[0, 25, 50, 75, 100].map((value) => <Button key={value} size="sm" variant="ghost" onClick={() => setDraft(Math.round((value / 100) * 4095))} disabled={disabled}>{value}%</Button>)}</div>
    <Button onClick={() => void onCommand(commandKind, draft)} disabled={disabled}><Activity /> APPLY ACKNOWLEDGED OUTPUT</Button>
  </div>;
}
