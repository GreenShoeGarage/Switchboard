"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownToLine, Check, Gauge, RefreshCw, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DevicePin, DeviceRecord, TelemetrySample } from "@/lib/device-model";

type Props = {
  device: DeviceRecord;
  pins: DevicePin[];
  liveLink: "CONNECTING" | "LIVE" | "RECONNECTING" | "STOPPED";
  onPins(pins: DevicePin[]): void;
  notify(message: string): void;
};
type Calibration = { unit: string; inputLow: string; outputLow: string; inputHigh: string; outputHigh: string };

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function calibrationFor(pin: DevicePin): Calibration {
  return {
    unit: pin.engineeringUnit ?? "",
    inputLow: pin.scaleInputLow?.toString() ?? "",
    outputLow: pin.scaleOutputLow?.toString() ?? "",
    inputHigh: pin.scaleInputHigh?.toString() ?? "",
    outputHigh: pin.scaleOutputHigh?.toString() ?? "",
  };
}

function clock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function TelemetryWorkbench({ device, pins, liveLink, onPins, notify }: Props) {
  const analogPins = pins.filter((pin) => pin.capability.includes("ANALOG"));
  const [selectedPinId, setSelectedPinId] = useState(analogPins.find((pin) => pin.pinId === "A0")?.pinId ?? analogPins[0]?.pinId ?? "A0");
  const selectedPin = analogPins.find((pin) => pin.pinId === selectedPinId) ?? analogPins[0];
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [retention, setRetention] = useState({ minimumIntervalMs: 1000, maximumSamplesPerPin: 720 });
  const [calibration, setCalibration] = useState<Calibration>(() => selectedPin ? calibrationFor(selectedPin) : { unit: "", inputLow: "", outputLow: "", inputHigh: "", outputHigh: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedPin) return;
    let cancelled = false;
    void fetchJson<{ samples: TelemetrySample[]; retention: typeof retention }>(`/api/devices/${encodeURIComponent(device.id)}/telemetry?pinId=${encodeURIComponent(selectedPin.pinId)}&limit=240`)
      .then((payload) => { if (!cancelled) { setSamples(payload.samples.slice().reverse()); setRetention(payload.retention); } })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : "Telemetry could not be loaded"); });
    return () => { cancelled = true; };
  }, [device.id, selectedPin, notify]);

  const chart = useMemo(() => {
    const values = samples.map((sample) => sample.engineeringValue);
    const rawMin = values.length ? Math.min(...values) : 0;
    const rawMax = values.length ? Math.max(...values) : 1;
    const span = Math.max(Math.abs(rawMax - rawMin), Math.abs(rawMax) * 0.02, 0.01);
    const padding = span * 0.12;
    const minimum = rawMin - padding; const maximum = rawMax + padding;
    const points = samples.map((sample, index) => {
      const x = samples.length <= 1 ? 340 : (index / (samples.length - 1)) * 680;
      const y = 200 - ((sample.engineeringValue - minimum) / Math.max(maximum - minimum, 0.000001)) * 170;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    return { rawMin, rawMax, minimum, maximum, points };
  }, [samples]);

  function choosePin(pinId: string) {
    const pin = analogPins.find((candidate) => candidate.pinId === pinId);
    setSelectedPinId(pinId); setSamples([]);
    if (pin) setCalibration(calibrationFor(pin));
  }

  async function saveCalibration() {
    if (!selectedPin) return;
    const values = [calibration.inputLow, calibration.outputLow, calibration.inputHigh, calibration.outputHigh];
    const clear = values.every((value) => value.trim() === "") && calibration.unit.trim() === "";
    if (!clear && (values.some((value) => value.trim() === "" || !Number.isFinite(Number(value))) || !calibration.unit.trim())) {
      notify("Enter both calibration points and an engineering unit, or clear every field"); return;
    }
    setSaving(true);
    try {
      const body = clear ? {
        pinId: selectedPin.pinId, engineeringUnit: null,
        scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null,
      } : {
        pinId: selectedPin.pinId, engineeringUnit: calibration.unit,
        scaleInputLow: Number(calibration.inputLow), scaleOutputLow: Number(calibration.outputLow),
        scaleInputHigh: Number(calibration.inputHigh), scaleOutputHigh: Number(calibration.outputHigh),
      };
      const payload = await fetchJson<{ pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(device.id)}/pins`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      onPins(payload.pins); notify(clear ? "Analog calibration cleared; future samples will use volts" : `${selectedPin.pinId} calibration saved for future samples`);
    } catch (error) { notify(error instanceof Error ? error.message : "Calibration was not saved"); }
    finally { setSaving(false); }
  }

  const latest = samples.at(-1);
  const unit = latest?.engineeringUnit ?? selectedPin?.engineeringUnit ?? "V";

  return <section className="content-screen telemetry-screen">
    <div className="page-heading"><div><p>ANALOG TELEMETRY / BATCH 6</p><h1>Monitor</h1><span>Persisted, bounded samples retain raw Analog-to-Digital Converter counts, calculated voltage, and calibrated engineering values.</span></div><span className="live-tag"><span className={`status-led ${liveLink === "LIVE" ? "green" : liveLink === "STOPPED" ? "red" : "amber"}`} />{liveLink} STREAM</span></div>

    <div className="telemetry-layout">
      <article className="instrument-card telemetry-chart-card">
        <div className="monitor-head"><div><span>{selectedPin?.pinId ?? "—"}</span><strong>{selectedPin?.label || "Analog channel"}</strong><small>{samples.length} persisted samples · newest at right</small></div><div className="monitor-value"><strong>{latest?.engineeringValue.toFixed(2) ?? "—"}</strong><span>{unit}<small>{latest ? `${latest.voltageValue.toFixed(4)} V · RAW ${latest.rawValue}` : "AWAITING SAMPLE"}</small></span></div></div>
        <div className="telemetry-toolbar"><label className="field-label">CHANNEL<Select value={selectedPin?.pinId} onValueChange={choosePin}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{analogPins.map((pin) => <SelectItem value={pin.pinId} key={pin.pinId}>{pin.pinId} · {pin.label || "Analog input"}</SelectItem>)}</SelectContent></Select></label><Badge variant="outline">14-BIT ADC</Badge><Badge variant="outline">{retention.maximumSamplesPerPin} SAMPLE CAP</Badge><Button variant="outline" asChild><a href={`/api/devices/${encodeURIComponent(device.id)}/telemetry?pinId=${encodeURIComponent(selectedPin?.pinId ?? "A0")}&limit=${retention.maximumSamplesPerPin}&format=csv`} download><ArrowDownToLine /> EXPORT CSV</a></Button></div>
        <div className="scope-grid telemetry-scope"><svg viewBox="0 0 680 220" preserveAspectRatio="none" aria-label={`${selectedPin?.pinId ?? "Analog"} telemetry history`} role="img"><line x1="0" y1="30" x2="680" y2="30" /><line x1="0" y1="115" x2="680" y2="115" /><line x1="0" y1="200" x2="680" y2="200" />{chart.points && <polyline points={chart.points} />}</svg><span className="scope-axis top">{chart.maximum.toFixed(2)} {unit}</span><span className="scope-axis bottom">{chart.minimum.toFixed(2)} {unit}</span><span className="scope-time start">{samples[0] ? clock(samples[0].recordedAt) : "—"}</span><span className="scope-time end">{latest ? clock(latest.recordedAt) : "—"}</span><span className="scope-tag">{device.connectionState === "ONLINE" ? "LIVE · SERVER CONFIRMED" : "STALE · LAST CONFIRMED"}</span></div>
        <div className="monitor-stats"><div><small>MINIMUM</small><strong>{samples.length ? chart.rawMin.toFixed(2) : "—"} {unit}</strong></div><div><small>MAXIMUM</small><strong>{samples.length ? chart.rawMax.toFixed(2) : "—"} {unit}</strong></div><div><small>SAMPLE FLOOR</small><strong>{retention.minimumIntervalMs / 1000} SECOND</strong></div><div><small>RETENTION</small><strong>{retention.maximumSamplesPerPin} / PIN</strong></div></div>
      </article>

      <aside className="instrument-card calibration-card">
        <div className="card-head"><div><p>LINEAR CALIBRATION</p><h2><SlidersHorizontal /> Engineering scale</h2></div><Gauge /></div>
        <p>Map two measured input voltages to engineering values. The server keeps the raw count and voltage so the calculation remains auditable.</p>
        <label className="field-label">ENGINEERING UNIT<Input value={calibration.unit} onChange={(event) => setCalibration((current) => ({ ...current, unit: event.target.value }))} placeholder="PSI, °C, bar…" maxLength={16} /></label>
        <div className="calibration-points"><div><strong>LOW POINT</strong><label className="field-label">INPUT VOLTS<Input inputMode="decimal" value={calibration.inputLow} onChange={(event) => setCalibration((current) => ({ ...current, inputLow: event.target.value }))} /></label><label className="field-label">OUTPUT VALUE<Input inputMode="decimal" value={calibration.outputLow} onChange={(event) => setCalibration((current) => ({ ...current, outputLow: event.target.value }))} /></label></div><div><strong>HIGH POINT</strong><label className="field-label">INPUT VOLTS<Input inputMode="decimal" value={calibration.inputHigh} onChange={(event) => setCalibration((current) => ({ ...current, inputHigh: event.target.value }))} /></label><label className="field-label">OUTPUT VALUE<Input inputMode="decimal" value={calibration.outputHigh} onChange={(event) => setCalibration((current) => ({ ...current, outputHigh: event.target.value }))} /></label></div></div>
        <Button onClick={() => void saveCalibration()} disabled={saving || !selectedPin}><Check /> {saving ? "SAVING…" : "SAVE CALIBRATION"}</Button>
        <Button variant="ghost" onClick={() => { setCalibration({ unit: "", inputLow: "", outputLow: "", inputHigh: "", outputHigh: "" }); }}><RefreshCw /> CLEAR FORM</Button>
        <div className="calibration-note"><Activity /><span>Calibration changes apply to new samples. Historical exports retain the exact engineering values calculated when each sample arrived.</span></div>
      </aside>
    </div>

    <article className="instrument-card telemetry-table-card"><div className="card-head"><div><p>SAMPLE LEDGER</p><h2><Activity /> Raw and calibrated history</h2></div><span>{samples.length} LOADED</span></div><Table><TableHeader><TableRow><TableHead>RECORDED</TableHead><TableHead>PIN</TableHead><TableHead>RAW ADC</TableHead><TableHead>VOLTS</TableHead><TableHead>ENGINEERING</TableHead><TableHead>SEQUENCE</TableHead></TableRow></TableHeader><TableBody>{samples.slice().reverse().slice(0, 80).map((sample) => <TableRow key={sample.id}><TableCell>{clock(sample.recordedAt)}</TableCell><TableCell><strong>{sample.pinId}</strong></TableCell><TableCell>{sample.rawValue}</TableCell><TableCell>{sample.voltageValue.toFixed(6)} V</TableCell><TableCell className="text-green">{sample.engineeringValue.toFixed(4)} {sample.engineeringUnit}</TableCell><TableCell>{sample.sequence ?? "SIM"}</TableCell></TableRow>)}{samples.length === 0 && <TableRow><TableCell colSpan={6} className="table-empty">No persisted analog samples for this channel yet.</TableCell></TableRow>}</TableBody></Table></article>
  </section>;
}
