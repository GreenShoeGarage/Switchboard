"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, Cpu, Download, FileClock, HardDrive, LockKeyhole, Network, RefreshCw, Save, Shield, ShieldCheck, Siren, Wifi } from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AgentLogRecord, ConnectionEvent, DevicePin, DeviceRecord, SafeStateRunRecord } from "@/lib/device-model";

type Notify = (message: string) => void;

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function exactTime(timestamp: number | null) {
  return timestamp ? new Date(timestamp).toLocaleString() : "Never";
}

export function DeviceDetailsPanel({ device, events }: { device: DeviceRecord; events: ConnectionEvent[] }) {
  return <div className="device-details-layout">
    <article className="instrument-card device-facts-card"><div className="card-head"><div><p>IDENTITY + RUNTIME</p><h2><Cpu /> Device details</h2></div><Badge variant="outline">{device.kind}</Badge></div><dl className="device-facts">
      <div><dt>Device ID</dt><dd>{device.id}</dd></div><div><dt>Board</dt><dd>{device.boardName}</dd></div><div><dt>Board profile</dt><dd>{device.boardProfileId}</dd></div><div><dt>Agent</dt><dd>{device.agentVersion ?? "Not reported"}</dd></div><div><dt>Wi-Fi firmware</dt><dd>{device.firmwareVersion ?? "Not reported"}</dd></div><div><dt>Configuration</dt><dd>Version {device.configurationVersion}</dd></div><div><dt>Created</dt><dd>{exactTime(device.createdAt)}</dd></div><div><dt>Updated</dt><dd>{exactTime(device.updatedAt)}</dd></div>
    </dl></article>
    <article className="instrument-card device-network-card"><div className="card-head"><div><p>CONNECTION</p><h2><Network /> Live device path</h2></div><span className={`state-text ${device.connectionState.toLowerCase()}`}>{device.connectionState}</span></div><div className="device-network-metrics"><div><Wifi /><small>RSSI</small><strong>{device.rssiDbm ?? "—"} dBm</strong></div><div><Network /><small>IP ADDRESS</small><strong>{device.ipAddress ?? "Not reported"}</strong></div><div><Clock3 /><small>LAST SEEN</small><strong>{exactTime(device.lastSeenAt)}</strong></div><div><ShieldCheck /><small>CONTROL SYNC</small><strong>{device.controlReady || device.simulated ? "READY" : "AWAITING FULL SNAPSHOT"}</strong></div></div><p className="device-detail-note">The registry can be online before remote control is ready. A physical session becomes control-ready only after the server accepts its complete state snapshot.</p></article>
    <article className="instrument-card device-events-card"><div className="card-head"><div><p>PERSISTENT HISTORY</p><h2><FileClock /> Connection events</h2></div><span>{events.length} RECORDS</span></div><Table><TableHeader><TableRow><TableHead>WHEN</TableHead><TableHead>STATE</TableHead><TableHead>REASON</TableHead></TableRow></TableHeader><TableBody>{events.map((event) => <TableRow key={event.id}><TableCell>{exactTime(event.occurredAt)}</TableCell><TableCell className={`state-text ${event.state.toLowerCase()}`}>{event.state}</TableCell><TableCell>{event.reason || "—"}</TableCell></TableRow>)}{!events.length && <TableRow><TableCell colSpan={3} className="table-empty">No connection events are recorded.</TableCell></TableRow>}</TableBody></Table></article>
  </div>;
}

export function DeviceLogsPanel({ device, notify }: { device: DeviceRecord; notify: Notify }) {
  const [logs, setLogs] = useState<AgentLogRecord[]>([]);
  const [level, setLevel] = useState("ALL");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const loadLogs = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (level !== "ALL") params.set("level", level);
      if (query.trim()) params.set("q", query.trim());
      const payload = await fetchJson<{ logs: AgentLogRecord[] }>(`/api/devices/${encodeURIComponent(device.id)}/logs?${params}`);
      if (requestId === requestSequence.current) setLogs(payload.logs);
    } catch (error) { notify(error instanceof Error ? error.message : "Agent logs could not be loaded"); }
    finally { if (requestId === requestSequence.current) setLoading(false); }
  }, [device.id, level, query, notify]);
  useEffect(() => { const timer = window.setTimeout(() => void loadLogs(), 250); return () => window.clearTimeout(timer); }, [loadLogs]);
  useEffect(() => {
    if (device.connectionState !== "ONLINE") return;
    const timer = window.setInterval(() => void loadLogs(), 5_000);
    return () => window.clearInterval(timer);
  }, [device.connectionState, loadLogs]);
  const exportUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: "200", format: "csv" });
    if (level !== "ALL") params.set("level", level); if (query.trim()) params.set("q", query.trim());
    return `/api/devices/${encodeURIComponent(device.id)}/logs?${params}`;
  }, [device.id, level, query]);
  return <article className="instrument-card workbench-log-card"><div className="workbench-log-toolbar"><div><p>SERVER-REDACTED</p><h2><HardDrive /> Agent logs</h2></div><label><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search code or message" maxLength={80} aria-label="Search agent logs" /></label><Select value={level} onValueChange={setLevel}><SelectTrigger aria-label="Filter log level"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All levels</SelectItem><SelectItem value="INFO">Information</SelectItem><SelectItem value="WARN">Warning</SelectItem><SelectItem value="ERROR">Error</SelectItem></SelectContent></Select><Button variant="outline" onClick={() => void loadLogs()} disabled={loading}><RefreshCw /> REFRESH</Button><Button asChild variant="outline"><a href={exportUrl} download><Download /> CSV</a></Button></div><div className="log-retention-note"><ShieldCheck /> The server stores the newest 500 redacted records per device; this view and export return at most 200.</div><Table><TableHeader><TableRow><TableHead>WHEN</TableHead><TableHead>LEVEL</TableHead><TableHead>CODE</TableHead><TableHead>MESSAGE</TableHead><TableHead>UPTIME</TableHead></TableRow></TableHeader><TableBody>{logs.map((log) => <TableRow key={log.id}><TableCell>{exactTime(log.recordedAt)}</TableCell><TableCell className={log.level === "ERROR" ? "text-red" : log.level === "WARN" ? "amber-text" : "text-green"}>{log.level}</TableCell><TableCell><strong>{log.code}</strong></TableCell><TableCell>{log.message || "—"}</TableCell><TableCell>{log.deviceUptimeMs === null ? "—" : `${log.deviceUptimeMs} ms`}</TableCell></TableRow>)}{!logs.length && <TableRow><TableCell colSpan={5} className="table-empty">{loading ? "Loading agent logs…" : "No matching agent logs."}</TableCell></TableRow>}</TableBody></Table></article>;
}

function safeDisplay(pin: DevicePin, value: number) {
  return pin.mode === "OUTPUT" ? (value ? "HIGH" : "LOW") : pin.mode === "PWM" ? `${((value / 4095) * 100).toFixed(1)}%` : `${((value / 4095) * 5).toFixed(3)} V`;
}

export function DeviceSafetyPanel({ device, pins, notify, onDevicePatch, onSafeValue, onApplySafeState }: {
  device: DeviceRecord; pins: DevicePin[]; notify: Notify;
  onDevicePatch(patch: { maintenanceMode?: boolean; monitorOnly?: boolean; automationArmed?: boolean }): Promise<void>;
  onSafeValue(pinId: string, value: number | null): Promise<void>;
  onApplySafeState(): Promise<void>;
}) {
  const outputPins = pins.filter((pin) => ["OUTPUT", "PWM", "DAC"].includes(pin.mode));
  const initialDrafts = Object.fromEntries(outputPins.map((pin) => [pin.pinId, pin.serverSafeValue === null ? "" : String(pin.serverSafeValue)]));
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const dirtyDrafts = useRef(new Set<string>());
  const [runs, setRuns] = useState<SafeStateRunRecord[]>([]);
  const [applying, setApplying] = useState(false);
  const loadRuns = useCallback(async () => {
    try { setRuns((await fetchJson<{ runs: SafeStateRunRecord[] }>(`/api/devices/${encodeURIComponent(device.id)}/safe-state`)).runs); }
    catch { /* the policy controls remain usable when history is unavailable */ }
  }, [device.id]);
  const safeValueSignature = JSON.stringify(outputPins.map((pin) => [pin.pinId, pin.mode, pin.serverSafeValue]));
  useEffect(() => {
    const nextValues = JSON.parse(safeValueSignature) as Array<[string, string, number | null]>;
    window.queueMicrotask(() => setDrafts((current) => Object.fromEntries(nextValues.map(([pinId, , value]) => [pinId, dirtyDrafts.current.has(pinId) ? current[pinId] ?? "" : value === null ? "" : String(value)]))));
  }, [safeValueSignature]);
  useEffect(() => { window.queueMicrotask(() => void loadRuns()); }, [loadRuns]);
  const configured = outputPins.filter((pin) => pin.serverSafeValue !== null);
  const blockedReason = device.connectionState !== "ONLINE" ? "Device is offline" : !device.controlReady && !device.simulated ? "Awaiting a synchronized full snapshot" : device.maintenanceMode ? "Maintenance Mode is active" : device.monitorOnly ? "Monitor Only is active" : null;
  async function savePin(pin: DevicePin) {
    const draft = drafts[pin.pinId]?.trim() ?? "";
    const value = draft === "" ? null : Number(draft);
    try {
      if (value !== null && !Number.isInteger(value)) throw new Error("Safe-state targets must be whole-number device counts");
      await onSafeValue(pin.pinId, value); dirtyDrafts.current.delete(pin.pinId); notify(`${pin.pinId} server safe-state target saved`);
    }
    catch (error) { notify(error instanceof Error ? error.message : "Safe-state target was not saved"); }
  }
  async function apply() {
    setApplying(true);
    try { await onApplySafeState(); await loadRuns(); }
    catch (error) { notify(error instanceof Error ? error.message : "The server safe-state run failed"); await loadRuns(); }
    finally { setApplying(false); }
  }
  const latest = runs[0];
  return <div className="safety-workbench">
    <div className="safety-lock-grid"><article className={`instrument-card policy-card ${device.monitorOnly ? "active" : ""}`}><div><Shield /><span><strong>Monitor Only</strong><small>Persistent server policy. Reads continue; all remote hardware changes are rejected.</small></span></div><Switch checked={device.monitorOnly} disabled={device.maintenanceMode} onCheckedChange={(checked) => void onDevicePatch({ monitorOnly: checked })} /></article><article className={`instrument-card policy-card maintenance ${device.maintenanceMode ? "active" : ""}`}><div><LockKeyhole /><span><strong>Maintenance Mode</strong><small>For physical work. Enabling Maintenance also enables Monitor Only; leaving it stays monitor-only until deliberately re-armed.</small></span></div><Switch checked={device.maintenanceMode} onCheckedChange={(checked) => void onDevicePatch({ maintenanceMode: checked })} /></article><article className={`instrument-card policy-card ${device.automationArmed ? "active" : ""}`}><div><ShieldCheck /><span><strong>Automation Permission</strong><small>Global device permission for every live rule targeting this instrument. Physical devices also require current HIL evidence.</small></span></div><Switch checked={device.automationArmed} disabled={device.maintenanceMode || device.monitorOnly} onCheckedChange={(checked) => void onDevicePatch({ automationArmed: checked })} aria-label={`${device.automationArmed ? "Disarm" : "Arm"} device automation permission`} /></article></div>
    <div className="safe-state-grid"><article className="instrument-card server-safe-card"><div className="card-head"><div><p>SERVER-COMMANDED</p><h2><Siren /> Safe-state profile</h2></div><Badge variant="outline">{configured.length} TARGETS</Badge></div><div className="safe-boundary"><AlertTriangle /><span>This profile requires an online, synchronized device and exact acknowledgments. Apply it before enabling a lock. It cannot protect hardware after complete communication loss.</span></div><div className="safe-pin-list">{outputPins.map((pin) => <div key={pin.pinId}><span><strong>{pin.pinId}</strong><small>{pin.label || pin.mode} · {pin.mode}</small></span><Input type="number" min="0" max={pin.mode === "OUTPUT" ? 1 : 4095} step="1" value={drafts[pin.pinId] ?? ""} onChange={(event) => { dirtyDrafts.current.add(pin.pinId); setDrafts((current) => ({ ...current, [pin.pinId]: event.target.value })); }} placeholder="Not set" aria-label={`${pin.pinId} server safe-state value`} /><Button variant="ghost" size="sm" onClick={() => void savePin(pin)}><Save /> SAVE</Button><em>{pin.serverSafeValue === null ? "NOT CONFIGURED" : safeDisplay(pin, pin.serverSafeValue)}</em></div>)}{!outputPins.length && <div className="table-empty">Configure an output, PWM, or DAC pin before defining a server safe state.</div>}</div><footer><span>{blockedReason ?? "Ready to send the complete profile through the acknowledged command ledger."}</span><AlertDialog><AlertDialogTrigger asChild><Button disabled={Boolean(blockedReason) || !configured.length || applying}><Siren /> APPLY SERVER SAFE STATE</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Apply the server safe-state profile?</AlertDialogTitle><AlertDialogDescription>This queues one traceable, exact-value command for every configured target. Outputs do not become confirmed safe until every device acknowledgment arrives.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void apply()}>APPLY PROFILE</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></footer>{latest && <div className={`safe-run-summary ${latest.status.toLowerCase()}`}>{latest.status === "ACKNOWLEDGED" ? <Check /> : latest.status === "FAILED" || latest.status === "TIMED_OUT" ? <AlertTriangle /> : <Clock3 />}<span><strong>{latest.status}</strong><small>{latest.acknowledgedCount}/{latest.targetCount} acknowledged · requested {exactTime(latest.requestedAt)}</small></span></div>}</article>
      <article className="instrument-card firmware-safe-card"><div className="card-head"><div><p>FIRMWARE-LOCAL</p><h2><Cpu /> Independent behavior</h2></div><Badge variant="outline">LAST REPORTED</Badge></div>{device.firmwareFailsafeMode === "SAFE_INPUT_BOOT" ? <div className="firmware-safe-state"><ShieldCheck /><strong>SAFE INPUT BOOT</strong><span>The current agent reports that every managed pin starts as INPUT. It does not report a link-loss timer, so SWITCHBOARD does not claim autonomous protection after disconnection.</span></div> : device.firmwareFailsafeMode === "LINK_LOSS_SAFE_STATE" ? <div className="firmware-safe-state"><ShieldCheck /><strong>LINK-LOSS SAFE STATE</strong><span>The agent reports a local timeout of {device.firmwareFailsafeTimeoutMs ?? "—"} ms. This is device-reported behavior and remains subject to physical HIL validation.</span></div> : <div className="firmware-safe-state unknown"><AlertTriangle /><strong>NOT REPORTED</strong><span>This device has not declared firmware-local safe behavior. Server configuration is not a substitute for firmware behavior.</span></div>}<dl><div><dt>Source</dt><dd>Authenticated device heartbeat</dd></div><div><dt>Reported</dt><dd>{exactTime(device.firmwareFailsafeReportedAt)}</dd></div><div><dt>Current certainty</dt><dd>{device.connectionState === "ONLINE" ? "LIVE REPORT" : "LAST REPORT · DEVICE OFFLINE"}</dd></div></dl></article></div>
  </div>;
}
