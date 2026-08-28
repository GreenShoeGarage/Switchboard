"use client";

import { Activity, GitCompareArrows, ShieldCheck, SlidersHorizontal, Tags } from "lucide-react";

import { AnalogOutputControl } from "@/app/analog-output-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DevicePin, GpioCommandRecord, PinMode } from "@/lib/device-model";

type PinMetadataPatch = Partial<Pick<DevicePin, "label" | "logicalLowLabel" | "logicalHighLabel">>;
type Props = {
  pin: DevicePin;
  commands: GpioCommandRecord[];
  pendingPin: { pinId: string; value?: number; mode?: PinMode } | null;
  online: boolean;
  controlBlocked?: boolean;
  lockReason?: string | null;
  maintenance?: boolean;
  onDraft(pinId: string, patch: PinMetadataPatch): void;
  onSave(pinId: string, patch: PinMetadataPatch): Promise<void>;
  onModeChange(pinId: string, mode: PinMode): Promise<void>;
  onAnalogOutput(kind: "WRITE_PWM" | "WRITE_DAC", pinId: string, value: number): Promise<void>;
};

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

function stateLabel(pin: DevicePin, value: number | null) {
  if (value === null) return "UNKNOWN";
  if (pin.mode === "PWM") return `${((value / 4095) * 100).toFixed(1)}%`;
  if (pin.mode === "DAC") return `${((value / 4095) * 5).toFixed(3)} V`;
  if (pin.mode === "ANALOG") return `${value.toFixed(3)} ${pin.engineeringUnit ?? "V"}`;
  return value ? pin.logicalHighLabel || "HIGH" : pin.logicalLowLabel || "LOW";
}

function commandSummary(command: GpioCommandRecord) {
  if (command.kind === "WRITE") return `${command.pinId} → ${command.requestedValue ? "HIGH" : "LOW"}`;
  if (command.kind === "WRITE_PWM") return `${command.pinId} PWM → ${(((command.requestedValue ?? 0) / 4095) * 100).toFixed(1)}%`;
  if (command.kind === "WRITE_DAC") return `${command.pinId} DAC → ${(((command.requestedValue ?? 0) / 4095) * 5).toFixed(3)} V`;
  return `${command.pinId} → ${command.requestedMode?.replace("_", " ") ?? "UNKNOWN MODE"}`;
}

export function GpioCommandPanels({ pin, commands, pendingPin, online, controlBlocked, lockReason, maintenance, onDraft, onSave, onModeChange, onAnalogOutput }: Props) {
  const blocked = controlBlocked ?? maintenance ?? false;
  const localPending = pendingPin?.pinId === pin.pinId ? pendingPin : null;
  const requestedMode = localPending?.mode ?? pin.requestedMode;
  const requestedValue = localPending?.value ?? pin.requestedValue;
  const hasRequest = Boolean(localPending || pin.pendingCommandId);
  const pinCommands = commands.filter((command) => command.pinId === pin.pinId);
  const batch6Modes = [
    pin.capability.includes("ANALOG") ? "ANALOG" : null,
    pin.capability.includes("PWM") ? "PWM" : null,
    pin.capability.includes("DAC") ? "DAC" : null,
  ].filter(Boolean) as PinMode[];

  return <>
    {batch6Modes.length > 0 && <article className="instrument-card batch6-output-card"><div className="card-head"><div><p>ANALOG / MODULATED MODE</p><h2><SlidersHorizontal /> Acknowledged output control</h2></div><Badge variant="outline">12-BIT OUTPUT</Badge></div><div className="batch6-mode-row"><span>MODE</span>{batch6Modes.map((mode) => <Button key={mode} size="sm" variant={pin.mode === mode ? "default" : "outline"} onClick={() => void onModeChange(pin.pinId, mode)} disabled={!online || blocked || hasRequest}>{mode}</Button>)}</div>{(pin.mode === "PWM" || pin.mode === "DAC") && <AnalogOutputControl key={`${pin.pinId}:${pin.mode}:${pin.confirmedValue}`} pin={pin} disabled={!online || blocked || hasRequest} onCommand={(kind, value) => onAnalogOutput(kind, pin.pinId, value)} />}<p className="gpio-contract-note">Mode and output values remain requested until the device acknowledges the exact pin, mode, and 12-bit count. {lockReason ?? (maintenance ? "Maintenance Mode blocks hardware-changing commands." : "The synchronized device is available for acknowledged commands.")}</p></article>}
    <section className="gpio-state-grid">
      <article className="instrument-card gpio-label-card">
        <div className="card-head"><div><p>PIN METADATA</p><h2><Tags /> {pin.pinId} labels</h2></div><Badge variant="outline">PERSISTENT</Badge></div>
        <div className="gpio-label-fields">
          <label className="field-label">PIN LABEL<Input value={pin.label} maxLength={60} placeholder="Example: Pump Relay" onChange={(event) => onDraft(pin.pinId, { label: event.target.value })} onBlur={(event) => void onSave(pin.pinId, { label: event.target.value })} /></label>
          <label className="field-label">LOGICAL LOW<Input value={pin.logicalLowLabel ?? ""} maxLength={40} placeholder="LOW / OFF / CLOSED" onChange={(event) => onDraft(pin.pinId, { logicalLowLabel: event.target.value || null })} onBlur={(event) => void onSave(pin.pinId, { logicalLowLabel: event.target.value || null })} /></label>
          <label className="field-label">LOGICAL HIGH<Input value={pin.logicalHighLabel ?? ""} maxLength={40} placeholder="HIGH / ON / OPEN" onChange={(event) => onDraft(pin.pinId, { logicalHighLabel: event.target.value || null })} onBlur={(event) => void onSave(pin.pinId, { logicalHighLabel: event.target.value || null })} /></label>
        </div>
      </article>

      <article className="instrument-card gpio-compare-card">
        <div className="card-head"><div><p>COMMAND STATE</p><h2><GitCompareArrows /> Requested vs. confirmed</h2></div><Badge variant="outline" className={hasRequest ? "gpio-status delivered" : "gpio-status acknowledged"}>{hasRequest ? pin.pendingCommandStatus ?? "SENDING" : "SYNCHRONIZED"}</Badge></div>
        <div className="gpio-state-compare">
          <div><small>REQUESTED MODE</small><strong className={requestedMode ? "amber-text" : ""}>{requestedMode?.replace("_", " ") ?? "—"}</strong></div>
          <div><small>CONFIRMED MODE</small><strong>{pin.mode.replace("_", " ")}</strong></div>
          <div><small>REQUESTED STATE</small><strong className={requestedValue !== null && requestedValue !== undefined ? "amber-text" : ""}>{requestedValue !== null && requestedValue !== undefined ? stateLabel(pin, requestedValue) : "—"}</strong></div>
          <div><small>CONFIRMED STATE</small><strong className={pin.confirmedValue ? "green-text" : ""}>{stateLabel(pin, pin.confirmedValue)}</strong></div>
        </div>
        <p className="gpio-contract-note">Requested values remain separate until a matching device acknowledgment arrives. Failed or timed-out commands never overwrite confirmed state.</p>
      </article>
    </section>

    <article className="instrument-card gpio-audit-card">
      <div className="card-head"><div><p>HARDWARE COMMAND AUDIT</p><h2><Activity /> Persistent command history</h2></div><span>{commands.length} RECORDS</span></div>
      <Table><TableHeader><TableRow><TableHead>REQUESTED</TableHead><TableHead>ACTOR</TableHead><TableHead>COMMAND</TableHead><TableHead>STATUS</TableHead><TableHead>LATENCY</TableHead><TableHead>DETAIL</TableHead></TableRow></TableHeader><TableBody>
        {commands.slice(0, 20).map((command) => <TableRow key={command.id} className={command.pinId === pin.pinId ? "selected-command" : ""}><TableCell>{relativeTime(command.requestedAt)}</TableCell><TableCell>{command.actor}</TableCell><TableCell><strong>{commandSummary(command)}</strong><small>{command.id}</small></TableCell><TableCell><span className={`gpio-status ${command.status.toLowerCase()}`}>{command.status}</span></TableCell><TableCell>{command.latencyMs === null ? "—" : `${command.latencyMs} ms`}</TableCell><TableCell>{command.error || (command.status === "ACKNOWLEDGED" ? <><ShieldCheck /> MATCHED</> : "—")}</TableCell></TableRow>)}
        {commands.length === 0 && <TableRow><TableCell colSpan={6} className="table-empty">No GPIO commands have been requested for this device.</TableCell></TableRow>}
      </TableBody></Table>
      {pinCommands.length > 0 && <footer>Selected pin: {pinCommands.length} command{pinCommands.length === 1 ? "" : "s"} · latest {pinCommands[0].status.toLowerCase()}</footer>}
    </article>
  </>;
}
