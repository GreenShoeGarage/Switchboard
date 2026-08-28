"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Cpu, FileClock, Info, LockKeyhole, Search, Shield, ShieldCheck, Siren, Terminal, Usb, Wifi } from "lucide-react";

import { DeviceDetailsPanel, DeviceLogsPanel, DeviceSafetyPanel } from "@/app/device-workbench-tools";
import { GpioCommandPanels } from "@/app/gpio-command-panels";
import { SerialConsole } from "@/app/serial-console";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ConnectionEvent, DevicePin, DeviceRecord, GpioCommandRecord, PinMode } from "@/lib/device-model";

export type DeviceWorkbenchTab = "board" | "details" | "serial" | "logs" | "safety";

type PinMetadataPatch = Partial<Pick<DevicePin, "label" | "logicalLowLabel" | "logicalHighLabel">>;
type Props = {
  device: DeviceRecord;
  pins: DevicePin[];
  events: ConnectionEvent[];
  commands: GpioCommandRecord[];
  selectedPinId: string;
  pendingPin: { pinId: string; value?: number; mode?: PinMode } | null;
  advanced: boolean;
  tab: DeviceWorkbenchTab;
  onTabChange(tab: DeviceWorkbenchTab): void;
  onSelectPin(pinId: string): void;
  onDigitalCommand(pinId: string, value: number): Promise<void>;
  onModeChange(pinId: string, mode: PinMode): Promise<void>;
  onAnalogOutput(kind: "WRITE_PWM" | "WRITE_DAC", pinId: string, value: number): Promise<void>;
  onDraft(pinId: string, patch: PinMetadataPatch): void;
  onSave(pinId: string, patch: PinMetadataPatch): Promise<void>;
  onDevicePatch(patch: { maintenanceMode?: boolean; monitorOnly?: boolean; automationArmed?: boolean }): Promise<void>;
  onSafeValue(pinId: string, value: number | null): Promise<void>;
  onApplySafeState(): Promise<void>;
  notify(message: string): void;
};

function pinState(pin: DevicePin, value = pin.confirmedValue) {
  if (value === null || value === undefined) return "UNKNOWN";
  if (pin.mode === "ANALOG") return `${value.toFixed(3)} ${pin.engineeringUnit ?? "V"}`;
  if (pin.mode === "PWM") return `${((value / 4095) * 100).toFixed(1)}%`;
  if (pin.mode === "DAC") return `${((value / 4095) * 5).toFixed(3)} V`;
  return value ? pin.logicalHighLabel || "HIGH" : pin.logicalLowLabel || "LOW";
}

function pendingState(pin: DevicePin, pending: Props["pendingPin"]) {
  if (pending?.pinId !== pin.pinId) return null;
  if (pending.mode) return `MODE → ${pending.mode.replace("_", " ")}`;
  const value = pending.value ?? 0;
  if (pin.mode === "PWM") return `${((value / 4095) * 100).toFixed(1)}% REQUESTED`;
  if (pin.mode === "DAC") return `${((value / 4095) * 5).toFixed(3)} V REQUESTED`;
  return value ? "HIGH REQUESTED" : "LOW REQUESTED";
}

function pinClass(pin: DevicePin, selectedPinId: string, pending: Props["pendingPin"]) {
  const classes = [pin.mode.toLowerCase()];
  if (pin.pinId === selectedPinId) classes.push("selected");
  if (pending?.pinId === pin.pinId || pin.pendingCommandId) classes.push("pending");
  if (["INPUT", "INPUT_PULLUP", "OUTPUT"].includes(pin.mode) && pin.confirmedValue === 1) classes.push("high");
  if (pin.serverSafeValue !== null) classes.push("safe-configured");
  return classes.join(" ");
}

export function DeviceWorkbench(props: Props) {
  const { device, pins, events, commands, selectedPinId, pendingPin, advanced, tab } = props;
  const [search, setSearch] = useState("");
  const selected = pins.find((pin) => pin.pinId === selectedPinId) ?? pins[0];
  const online = device.connectionState === "ONLINE";
  const synchronized = device.simulated || device.controlReady;
  const lockReason = device.maintenanceMode ? "Maintenance Mode is active"
    : device.monitorOnly ? "Monitor Only is active"
    : !online ? "Device is offline"
    : !synchronized ? "Awaiting an accepted full snapshot"
    : null;
  const controlBlocked = Boolean(lockReason);
  const visiblePins = useMemo(() => pins.filter((pin) => `${pin.pinId} ${pin.label} ${pin.mode}`.toLowerCase().includes(search.toLowerCase())), [pins, search]);

  return <section className="content-screen device-workbench-screen">
    <div className="page-heading"><div><p>DEVICE / {device.name.toUpperCase()} / BATCH 7</p><h1>Device Workbench</h1><span>Board state, Universal Serial Bus (USB) console, redacted agent logs, device details, and explicit safety policy share one instrument.</span></div><span className={`state-badge ${device.connectionState.toLowerCase()}`}>{device.connectionState}</span></div>
    {device.maintenanceMode && <div className="workbench-lock-banner maintenance"><LockKeyhole /><div><strong>MAINTENANCE MODE</strong><span>Reads continue. Every remote hardware-changing command is rejected until Maintenance Mode is cleared; Monitor Only remains armed.</span></div><Button variant="outline" size="sm" onClick={() => props.onTabChange("safety")}>REVIEW SAFETY</Button></div>}
    {!device.maintenanceMode && device.monitorOnly && <div className="workbench-lock-banner monitor"><Shield /><div><strong>MONITOR ONLY</strong><span>Telemetry, logs, and device details remain available. Remote output and mode changes are persistently blocked.</span></div><Button variant="outline" size="sm" onClick={() => props.onTabChange("safety")}>RE-ARM CONTROL</Button></div>}
    {!device.simulated && online && !device.controlReady && <div className="workbench-lock-banner sync"><ShieldCheck /><div><strong>CONTROL SYNC PENDING</strong><span>The authenticated session is online, but hardware control stays fenced until the server accepts a complete state snapshot.</span></div><Button variant="outline" size="sm" onClick={() => props.onTabChange("details")}>VIEW DETAILS</Button></div>}

    <Tabs value={tab} onValueChange={(value) => props.onTabChange(value as DeviceWorkbenchTab)} className="device-workbench-tabs">
      <TabsList variant="line" className="workbench-tab-list">
        <TabsTrigger value="board"><Cpu /> Board + Pins</TabsTrigger>
        <TabsTrigger value="details"><Info /> Details</TabsTrigger>
        <TabsTrigger value="serial"><Usb /> USB Console</TabsTrigger>
        <TabsTrigger value="logs"><Terminal /> Agent Logs</TabsTrigger>
        <TabsTrigger value="safety"><Siren /> Safety</TabsTrigger>
      </TabsList>

      <TabsContent value="board">
        {selected ? <>
          <div className="pin-layout"><article className="instrument-card board-panel"><div className="board-toolbar"><span><Cpu /> {device.boardName.toUpperCase()}</span><em>{device.simulated ? "SIMULATED DEVICE" : "PHYSICAL DEVICE"}</em></div><div className="uno-board"><div className="uno-usb"><span>USB-C</span></div><div className="uno-mark"><strong>UNO</strong><span>R4 WiFi</span></div><div className="board-chip"><span>RENESAS</span><strong>RA4M1</strong></div><div className="wifi-module"><Wifi /><span>ESP32-S3</span></div><div className="pin-bank digital-bank">{pins.filter((pin) => pin.pinId.startsWith("D")).map((pin) => <button key={pin.pinId} className={pinClass(pin, selectedPinId, pendingPin)} onClick={() => props.onSelectPin(pin.pinId)} aria-pressed={pin.pinId === selectedPinId} title={`${pin.pinId} · ${pin.mode} · ${pendingState(pin, pendingPin) ?? pinState(pin)}`}><i /><span>{pin.pinId}</span><small>{pin.mode}</small></button>)}</div><div className="pin-bank analog-bank">{pins.filter((pin) => pin.pinId.startsWith("A")).map((pin) => <button key={pin.pinId} className={pinClass(pin, selectedPinId, pendingPin)} onClick={() => props.onSelectPin(pin.pinId)} aria-pressed={pin.pinId === selectedPinId} title={`${pin.pinId} · ${pin.mode} · ${pendingState(pin, pendingPin) ?? pinState(pin)}`}><i /><span>{pin.pinId}</span><small>{pin.mode}</small></button>)}</div><span className={`board-led power ${online ? "lit" : "offline"}`}>ON</span><span className={`board-led link ${online ? "lit" : "offline"}`}>L</span></div><div className="legend"><span><i className="green" /> DIGITAL HIGH</span><span><i className="amber" /> SELECTED</span><span><i className="blue" /> ANALOG / MODULATED</span><span><i className="safe" /> SAFE TARGET</span></div></article>
          <aside className="instrument-card pin-inspector"><div className="inspector-title"><div><strong>{selected.pinId}</strong><span>{selected.label || "Unlabeled pin"}</span></div><em>{selected.capability}</em></div><label className="field-label">PIN MODE<Select value={selected.mode} onValueChange={(value) => void props.onModeChange(selected.pinId, value as PinMode)} disabled={controlBlocked || Boolean(pendingPin)}><SelectTrigger className="wide"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INPUT">Digital Input</SelectItem><SelectItem value="INPUT_PULLUP">Input Pull-up</SelectItem><SelectItem value="OUTPUT">Digital Output</SelectItem>{selected.capability.includes("PWM") && <SelectItem value="PWM">Pulse-Width Modulation (PWM)</SelectItem>}{selected.capability.includes("DAC") && <SelectItem value="DAC">Digital-to-Analog Converter (DAC)</SelectItem>}{selected.capability.includes("ANALOG") && <SelectItem value="ANALOG">Analog Input</SelectItem>}</SelectContent></Select></label><div className="large-state"><small>{pendingState(selected, pendingPin) ? "REQUESTED STATE" : online ? "CONFIRMED STATE" : "LAST CONFIRMED"}</small><strong className={pendingState(selected, pendingPin) ? "amber-text" : selected.mode !== "ANALOG" && selected.confirmedValue ? "green-text" : ""}>{pendingState(selected, pendingPin) ?? pinState(selected)}</strong>{advanced && <span>Configuration persisted · v{device.configurationVersion}</span>}</div>{selected.mode === "OUTPUT" && <div className="output-command"><Button variant={!selected.confirmedValue ? "default" : "outline"} onClick={() => void props.onDigitalCommand(selected.pinId, 0)} disabled={controlBlocked || Boolean(pendingPin)}>SET LOW</Button><Button variant={selected.confirmedValue ? "default" : "outline"} onClick={() => void props.onDigitalCommand(selected.pinId, 1)} disabled={controlBlocked || Boolean(pendingPin)}>SET HIGH</Button></div>}{selected.mode === "ANALOG" && <div className="scaling-block"><span>ENGINEERING SCALE</span><div><small>{selected.scaleInputLow ?? "—"} V</small><i /><small>{selected.scaleOutputLow ?? "—"} {selected.engineeringUnit ?? ""}</small></div><div><small>{selected.scaleInputHigh ?? "—"} V</small><i /><small>{selected.scaleOutputHigh ?? "—"} {selected.engineeringUnit ?? ""}</small></div></div>}<div className="electrical-note"><AlertTriangle /><span><strong>{lockReason ? "CONTROL FENCE" : "ELECTRICAL NOTE"}</strong>{lockReason ?? (selected.mode === "OUTPUT" ? "This pin is actively driven. Change it to input before connecting another driven signal." : "Capabilities and limits come from the validated board profile.")}</span></div>{selected.serverSafeValue !== null && <Badge variant="outline"><Siren /> SERVER SAFE TARGET: {selected.serverSafeValue}</Badge>}</aside></div>
          <article className="instrument-card pin-table-card"><div className="table-tools"><label><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find pin, label, or mode" /></label><span>{visiblePins.length} / {pins.length} PROFILE PINS</span></div><Table><TableHeader><TableRow><TableHead>PIN</TableHead><TableHead>LABEL</TableHead><TableHead>MODE</TableHead><TableHead>CAPABILITY</TableHead><TableHead>STATE</TableHead><TableHead>SAFE TARGET</TableHead><TableHead>SOURCE</TableHead></TableRow></TableHeader><TableBody>{visiblePins.map((pin) => <TableRow key={pin.pinId} onClick={() => props.onSelectPin(pin.pinId)} className="pin-table-row"><TableCell><strong>{pin.pinId}</strong></TableCell><TableCell>{pin.label || "—"}</TableCell><TableCell>{pin.mode.replace("_", " ")}</TableCell><TableCell>{pin.capability}</TableCell><TableCell className={["INPUT", "INPUT_PULLUP", "OUTPUT"].includes(pin.mode) && pin.confirmedValue ? "text-green" : ""}>{pendingState(pin, pendingPin) ?? pinState(pin)}</TableCell><TableCell>{pin.serverSafeValue ?? "—"}</TableCell><TableCell>{device.simulated ? "SIMULATOR" : "DEVICE"}</TableCell></TableRow>)}</TableBody></Table></article>
          <GpioCommandPanels pin={selected} commands={commands} pendingPin={pendingPin} online={online} controlBlocked={controlBlocked} lockReason={lockReason} onDraft={props.onDraft} onSave={props.onSave} onModeChange={props.onModeChange} onAnalogOutput={props.onAnalogOutput} />
        </> : <article className="instrument-card table-empty">This board profile has no pins.</article>}
      </TabsContent>
      <TabsContent value="details"><DeviceDetailsPanel device={device} events={events} /></TabsContent>
      <TabsContent value="serial"><SerialConsole deviceName={device.name} notify={props.notify} /></TabsContent>
      <TabsContent value="logs"><DeviceLogsPanel device={device} notify={props.notify} /></TabsContent>
      <TabsContent value="safety"><DeviceSafetyPanel device={device} pins={pins} notify={props.notify} onDevicePatch={props.onDevicePatch} onSafeValue={props.onSafeValue} onApplySafeState={props.onApplySafeState} /></TabsContent>
    </Tabs>
    <div className="workbench-boundary"><FileClock /><span><strong>CONFIDENCE BOUNDARY</strong> Server safe-state runs are command-ledger operations. Firmware-local behavior is reported separately and physical hardware-in-the-loop validation remains pending.</span></div>
  </section>;
}
