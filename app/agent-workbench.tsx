"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Check, Clipboard, Cpu, Download, FileCheck2, KeyRound,
  Link2, LockKeyhole, Play, RefreshCw, RotateCcw, ShieldCheck, Terminal, Usb,
  Wifi, X,
} from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AgentLogRecord, DeviceRecord, HilRunRecord, HilStepKey, HilStepStatus, TransportBundle } from "@/lib/device-model";
import { validateFirmwareManifest, verifyFirmwareAsset, type FirmwareManifest } from "@/lib/firmware-manifest";
import { requestUnoR4Port, supportsWebSerial, UnoR4SerialSession, type AgentStatus, type SerialPortRef } from "@/lib/flasher/web-serial";

type IssuedToken = { record: { deviceName: string }; secret: string; expiresInMinutes: number };
type Props = {
  activeDevice: DeviceRecord | null;
  devices: DeviceRecord[];
  onSelectDevice(id: string): void;
  onRegistryRefresh(preferredId?: string): Promise<void>;
  notify(message: string): void;
};

const stepLabels: Record<HilStepKey, string> = {
  ENROLLMENT: "One-time token exchanged",
  AUTHENTICATION: "Permanent credential authenticated",
  SAFE_BOOT: "All managed pins booted as inputs",
  D7_HIGH_ELECTRICAL: "D7 HIGH verified electrically",
  D2_HIGH_SNAPSHOT: "D2 reported HIGH in a fresh snapshot",
  D7_LOW_ELECTRICAL: "D7 LOW verified electrically",
  D2_LOW_SNAPSHOT: "D2 reported LOW in a fresh snapshot",
  CYCLE_TEST: "1,000-cycle loopback completed",
  WIFI_RECOVERY: "Wi-Fi outage recovered",
  SERVER_RECOVERY: "Server restart recovered",
  BOARD_RECOVERY: "Board restart recovered safely",
  BROWSER_RECOVERY: "Browser restart recovered",
  FRESH_SNAPSHOT: "Reconnect produced a fresh full snapshot",
  SAFE_LOGS: "Logs contain no credentials or Wi-Fi password",
};

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function relativeTime(timestamp: number | null) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

export function AgentWorkbench({ activeDevice, devices, onSelectDevice, onRegistryRefresh, notify }: Props) {
  const physicalDevices = devices.filter((device) => !device.simulated && device.kind === "PHYSICAL");
  const [deviceName, setDeviceName] = useState("Workshop UNO R4");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState("443");
  const [secure, setSecure] = useState(true);
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [selectedPhysicalId, setSelectedPhysicalId] = useState(activeDevice && !activeDevice.simulated ? activeDevice.id : "NONE");
  const [runs, setRuns] = useState<HilRunRecord[]>([]);
  const [activeRun, setActiveRun] = useState<HilRunRecord | null>(null);
  const [observations, setObservations] = useState<Record<string, string>>({});
  const [cycles, setCycles] = useState("0");
  const [failures, setFailures] = useState("0");
  const [logs, setLogs] = useState<AgentLogRecord[]>([]);
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
  const [sourceIntegrity, setSourceIntegrity] = useState<"checking" | "verified" | "failed">("checking");
  const [webSerialAvailable, setWebSerialAvailable] = useState(false);
  const [serialPort, setSerialPort] = useState<SerialPortRef | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [serialBusy, setSerialBusy] = useState(false);
  const [serialMessage, setSerialMessage] = useState("Select the Arduino runtime port to begin.");

  const selectedPhysical = physicalDevices.find((device) => device.id === selectedPhysicalId) ?? null;
  const provisioningJson = useMemo(() => issuedToken ? JSON.stringify({
    action: "provision", deviceName, wifiSsid, wifiPassword, serverHost,
    serverPort: Number(serverPort), secure, enrollmentToken: issuedToken.secret,
  }) : "", [issuedToken, deviceName, wifiSsid, wifiPassword, serverHost, serverPort, secure]);

  const adoptRun = useCallback((run: HilRunRecord | null) => {
    setActiveRun(run);
    if (!run) { setCycles("0"); setFailures("0"); setObservations({}); return; }
    setCycles(String(run.completedCycles)); setFailures(String(run.failureCount));
    setObservations(Object.fromEntries(run.steps.map((step) => [step.stepKey, step.observation])));
  }, [setActiveRun, setCycles, setFailures, setObservations]);

  const loadHardwareRecords = useCallback(async (deviceId: string) => {
    const [hilPayload, transport] = await Promise.all([
      fetchJson<{ runs: HilRunRecord[] }>(`/api/devices/${encodeURIComponent(deviceId)}/hil`),
      fetchJson<TransportBundle>(`/api/devices/${encodeURIComponent(deviceId)}/transport`),
    ]);
    setRuns(hilPayload.runs); adoptRun(hilPayload.runs.find((run) => run.status === "RUNNING") ?? hilPayload.runs[0] ?? null);
    setLogs(transport.logs);
  }, [adoptRun]);

  useEffect(() => {
    if (selectedPhysicalId === "NONE") return;
    window.queueMicrotask(() => void loadHardwareRecords(selectedPhysicalId).catch(() => notify("Physical agent records could not be loaded")));
  }, [selectedPhysicalId, loadHardwareRecords, notify]);

  useEffect(() => {
    window.queueMicrotask(() => {
      setWebSerialAvailable(supportsWebSerial());
      setServerHost((current) => current || window.location.hostname);
    });
    void (async () => {
      try {
        const response = await fetch("/firmware/manifest-v1.json", { cache: "no-store" });
        if (!response.ok) throw new Error("Manifest could not be loaded.");
        const candidate = validateFirmwareManifest(await response.json());
        setManifest(candidate);
        const source = new Uint8Array(await (await fetch(candidate.source.url, { cache: "no-store" })).arrayBuffer());
        setSourceIntegrity(await verifyFirmwareAsset(source, candidate.source) ? "verified" : "failed");
      } catch { setSourceIntegrity("failed"); }
    })();
  }, []);

  async function createProvisioningToken(): Promise<IssuedToken | null> {
    if (!deviceName.trim() || !wifiSsid.trim() || !serverHost.trim() || !Number(serverPort)) {
      notify("Device name, Wi-Fi network, and a device-accessible server host are required");
      return null;
    }
    try {
      const token = await fetchJson<IssuedToken>("/api/enrollment-tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardProfileId: "arduino-uno-r4-wifi", deviceName, ttlMinutes: 15 }),
      });
      setIssuedToken(token); notify("One-time token created; provisioning payload is ready"); return token;
    } catch (error) { notify(error instanceof Error ? error.message : "Provisioning token was not created"); return null; }
  }

  async function runSerial(action: () => Promise<void>) {
    setSerialBusy(true);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : "Serial operation failed"; setSerialMessage(message); notify(message); }
    finally { setSerialBusy(false); }
  }

  async function selectBoard() {
    await runSerial(async () => {
      const port = await requestUnoR4Port();
      const session = new UnoR4SerialSession(port);
      const identity = session.identity();
      if (identity.usbMode === "unknown") throw new Error("The selected USB device is not an Arduino UNO R4 WiFi.");
      setSerialPort(port); setAgentStatus(null);
      setSerialMessage(identity.usbMode === "bootloader" ? "Bootloader detected. Double-tap reset or power-cycle to return to the agent." : "UNO R4 WiFi runtime port selected. Identify the agent next.");
    });
  }

  async function identifyAgent() {
    if (!serialPort) return;
    await runSerial(async () => {
      const status = await new UnoR4SerialSession(serialPort).identifyAgent();
      setAgentStatus(status);
      setSerialMessage(`Agent ${status.agentVersion} identified; ${status.configured ? "configuration present" : "ready for provisioning"}.`);
    });
  }

  async function enterBootloader() {
    if (!serialPort) return;
    await runSerial(async () => {
      await new UnoR4SerialSession(serialPort).enterBootloader();
      setSerialPort(null); setAgentStatus(null);
      setSerialMessage("1200-bps reset sent. The port may change; select the UNO R4 bootloader when it appears.");
      notify("Bootloader handoff sent; reselect the changed USB port");
    });
  }

  async function provisionOverUsb() {
    if (!serialPort) { notify("Select and identify the board first"); return; }
    await runSerial(async () => {
      const token = issuedToken ?? await createProvisioningToken();
      if (!token) return;
      await new UnoR4SerialSession(serialPort).provision({
        action: "provision", deviceName, wifiSsid, wifiPassword, serverHost,
        serverPort: Number(serverPort), secure, enrollmentToken: token.secret,
      });
      setIssuedToken(null); setWifiPassword(""); setAgentStatus(null); setSerialPort(null);
      setSerialMessage("Provisioning was stored and the board restarted. Reselect it after Wi-Fi enrollment to verify status.");
      notify("Provisioning acknowledged; Wi-Fi password cleared from this page");
    });
  }

  async function verifyAgentStatus() {
    if (!serialPort) return;
    await runSerial(async () => {
      const status = await new UnoR4SerialSession(serialPort).readStatus();
      setAgentStatus(status);
      setSerialMessage(status.enrolled && status.socketAuthenticated ? "Enrollment and authenticated device socket verified." : status.configured ? "Configuration is stored; the board is still connecting or enrolling." : "No configuration is stored.");
    });
  }

  async function clearAgentConfiguration() {
    if (!serialPort) return;
    await runSerial(async () => {
      await new UnoR4SerialSession(serialPort).clearConfiguration();
      setAgentStatus(null); setSerialPort(null); setIssuedToken(null); setWifiPassword("");
      setSerialMessage("Network configuration and device credential erased. Reselect the restarted board to provision again.");
      notify("Board configuration erased");
    });
  }

  async function copyProvisioningPayload() {
    if (!provisioningJson) return;
    try { await navigator.clipboard.writeText(provisioningJson); notify("Provisioning JSON copied; paste it once at 115200 baud"); }
    catch { notify("Clipboard access was blocked; select the payload manually"); }
  }

  async function startHilRun() {
    if (!selectedPhysical) return;
    try {
      const payload = await fetchJson<{ run: HilRunRecord }>(`/api/devices/${encodeURIComponent(selectedPhysical.id)}/hil`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetCycles: 1000 }),
      });
      adoptRun(payload.run); await loadHardwareRecords(selectedPhysical.id); notify("Hardware-in-the-Loop run started");
    } catch (error) { notify(error instanceof Error ? error.message : "Hardware-in-the-Loop run did not start"); }
  }

  async function updateRun(patch: Record<string, unknown>) {
    if (!selectedPhysical || !activeRun) return;
    try {
      const payload = await fetchJson<{ run: HilRunRecord }>(`/api/devices/${encodeURIComponent(selectedPhysical.id)}/hil`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: activeRun.id, ...patch }),
      });
      adoptRun(payload.run); setRuns((current) => [payload.run, ...current.filter((run) => run.id !== payload.run.id)]);
      if (payload.run.status === "PASSED") notify("Hardware-in-the-Loop evidence is complete and operator-attested");
    } catch (error) { notify(error instanceof Error ? error.message : "Hardware test record was not updated"); }
  }

  function selectPhysical(id: string) {
    setSelectedPhysicalId(id);
    if (id === "NONE") { setRuns([]); setLogs([]); adoptRun(null); return; }
    onSelectDevice(id);
  }

  const usbIdentity = serialPort ? new UnoR4SerialSession(serialPort).identity() : null;

  return <section className="content-screen agent-screen">
    <div className="page-heading"><div><p>UNO R4 WIFI / BATCH 5</p><h1>Browser Provisioning</h1><span>Identify the board, verify the release manifest, enroll over USB, and recover without exposing Wi-Fi credentials to the server.</span></div><Badge variant="outline" className="agent-candidate"><Activity /> FLASH LOCKED · HIL PENDING</Badge></div>

    <div className="transport-boundary"><LockKeyhole /><div><strong>PUBLIC DEVICE GATEWAY · OWNER-GATED WORKBENCH</strong><span>External boards use this host on TLS port 443. Anonymous traffic is admitted only to one-time enrollment exchange and the authenticated device WebSocket; workbench pages and operator APIs require a local owner session.</span></div></div>

    <section className="agent-flow">
      {[{ icon: Usb, title: "SELECT", detail: "USB identity" }, { icon: FileCheck2, title: "VERIFY", detail: "Manifest + SHA-256" }, { icon: KeyRound, title: "PROVISION", detail: "Secret over USB only" }, { icon: Wifi, title: "ENROLL", detail: "One-time token" }, { icon: RotateCcw, title: "RECOVER", detail: "Reset + reselect" }].map((step, index) => <article className="instrument-card" key={step.title}><span>{index + 1}</span><step.icon /><strong>{step.title}</strong><small>{step.detail}</small></article>)}
    </section>

    <div className="provisioning-grid">
      <article className="instrument-card firmware-integrity-card">
        <div className="card-head"><div><p>RELEASE MANIFEST</p><h2><FileCheck2 /> Agent v0.8.0 candidate</h2></div><Badge variant="outline" className={sourceIntegrity === "verified" ? "manifest-good" : "manifest-pending"}>{sourceIntegrity.toUpperCase()}</Badge></div>
        <div className="manifest-readout"><div><small>BOARD</small><strong>{manifest?.board.profileId ?? "Loading…"}</strong></div><div><small>UPLOAD</small><strong>SAM-BA · 921600 baud</strong></div><div><small>SOURCE SHA-256</small><code>{manifest?.source.sha256 ?? "Checking manifest…"}</code></div><div><small>BINARY</small><strong className="amber-text">NOT PUBLISHED</strong></div></div>
        <div className="honest-gate compact"><LockKeyhole /><div><strong>ERASE / WRITE INTERLOCK ACTIVE</strong><span>The source hash is independently checked in this browser. A compiled binary cannot be offered as known-good until Batch 4 physical HIL evidence exists.</span></div></div>
        <div className="manifest-actions"><Button asChild variant="outline"><a href="/firmware/SWITCHBOARD-Agent-v0.8.0.ino" download><Download /> DOWNLOAD CANDIDATE SOURCE</a></Button><Button asChild variant="ghost"><a href="/firmware/manifest-v1.json" download><FileCheck2 /> MANIFEST</a></Button></div>
      </article>

      <article className="instrument-card usb-session-card">
        <div className="card-head"><div><p>LOCAL USB SESSION</p><h2><Usb /> Board identity</h2></div><Badge variant="outline" className={webSerialAvailable ? "manifest-good" : "manifest-pending"}>{webSerialAvailable ? "WEB SERIAL READY" : "DESKTOP CHROMIUM REQUIRED"}</Badge></div>
        <div className={`usb-result ${usbIdentity?.usbMode ?? "idle"}`}><Cpu /><div><strong>{usbIdentity?.displayName ?? "No board selected"}</strong><span>{usbIdentity ? `VID 0x${usbIdentity.vendorId?.toString(16).padStart(4, "0")} · PID 0x${usbIdentity.productId?.toString(16).padStart(4, "0")} · ${usbIdentity.usbMode.toUpperCase()}` : serialMessage}</span></div></div>
        {agentStatus && <dl><div><dt>Agent</dt><dd>{agentStatus.agentVersion}</dd></div><div><dt>Configured</dt><dd>{agentStatus.configured ? "YES" : "NO"}</dd></div><div><dt>Enrolled</dt><dd>{agentStatus.enrolled ? "YES" : "NO"}</dd></div><div><dt>Socket</dt><dd>{agentStatus.socketAuthenticated ? "AUTHENTICATED" : "NOT CONNECTED"}</dd></div></dl>}
        <p className="serial-message">{serialMessage}</p>
        <div className="usb-actions"><Button onClick={() => void selectBoard()} disabled={!webSerialAvailable || serialBusy}><Link2 /> {serialPort ? "RESELECT BOARD" : "SELECT BOARD"}</Button><Button variant="outline" onClick={() => void identifyAgent()} disabled={!serialPort || usbIdentity?.usbMode !== "runtime" || serialBusy}><Cpu /> IDENTIFY AGENT</Button><Button variant="ghost" onClick={() => void enterBootloader()} disabled={!serialPort || usbIdentity?.usbMode !== "runtime" || serialBusy}><RotateCcw /> ENTER BOOTLOADER</Button></div>
      </article>
    </div>

    <article className="instrument-card provisioning-card">
      <div className="card-head"><div><p>GUIDED WI-FI ENROLLMENT</p><h2><Terminal /> Provision directly over USB</h2></div><span>WI-FI SECRET NEVER SENT TO THIS SITE</span></div>
      <div className="provision-fields"><label className="field-label">DEVICE NAME<Input value={deviceName} onChange={(event) => { setDeviceName(event.target.value); setIssuedToken(null); }} maxLength={48} /></label><label className="field-label">WI-FI NETWORK<Input value={wifiSsid} onChange={(event) => { setWifiSsid(event.target.value); setIssuedToken(null); }} maxLength={32} /></label><label className="field-label">WI-FI PASSWORD<Input type="password" value={wifiPassword} onChange={(event) => { setWifiPassword(event.target.value); setIssuedToken(null); }} maxLength={64} autoComplete="new-password" /></label><label className="field-label">DEVICE SERVER HOST<Input value={serverHost} onChange={(event) => { setServerHost(event.target.value.replace(/^https?:\/\//, "").split("/")[0]); setIssuedToken(null); }} placeholder="switchboard.example.com" maxLength={95} /></label><label className="field-label">PORT<Input inputMode="numeric" value={serverPort} onChange={(event) => { setServerPort(event.target.value.replace(/\D/g, "").slice(0, 5)); setIssuedToken(null); }} /></label><label className="field-label provision-switch">SECURE TLS<span><Switch checked={secure} onCheckedChange={(value) => { setSecure(value); setIssuedToken(null); }} /><em>{secure ? "REQUIRED FOR PRODUCTION" : "LOCAL DEVELOPMENT ONLY"}</em></span></label></div>
      <div className="provision-actions"><Button onClick={() => void provisionOverUsb()} disabled={!serialPort || usbIdentity?.usbMode !== "runtime" || serialBusy}><KeyRound /> CREATE TOKEN + PROVISION USB</Button><Button variant="outline" onClick={() => void verifyAgentStatus()} disabled={!serialPort || usbIdentity?.usbMode !== "runtime" || serialBusy}><ShieldCheck /> VERIFY STATUS</Button><Button variant="ghost" onClick={() => { setIssuedToken(null); setWifiPassword(""); }}><RotateCcw /> CLEAR LOCAL SECRETS</Button></div>
      <small>The server receives only the device name and a short-lived enrollment-token request. The browser writes the Wi-Fi name, Wi-Fi password, server address, and token directly to the selected USB serial port, then clears the password field after the board acknowledges storage.</small>
      {!webSerialAvailable && <div className="manual-fallback"><strong>MANUAL SERIAL FALLBACK</strong><span>Create a payload only when Web Serial is unavailable, then paste it once at 115200 baud. Treat the visible JSON as a secret.</span>{!issuedToken ? <Button variant="outline" onClick={() => void createProvisioningToken()}><KeyRound /> CREATE FALLBACK PAYLOAD</Button> : <><code className="provision-payload">{provisioningJson}</code><Button variant="outline" onClick={() => void copyProvisioningPayload()}><Clipboard /> COPY SECRET PAYLOAD</Button></>}</div>}
    </article>

    <div className="agent-grid">
      <article className="instrument-card recovery-card">
        <div className="card-head"><div><p>USB RECOVERY</p><h2><RotateCcw /> Return to a known entry point</h2></div><AlertTriangle /></div>
        <ol><li>Double-tap RESET if the application port does not appear; the L LED should pulse in bootloader mode.</li><li>Select the changed USB port again. A 1200-bps handoff can also enter the bootloader from the runtime port.</li><li>Do not overwrite the separate ESP32-S3 USB bridge firmware while recovering the RA4M1 application.</li></ol>
        <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" disabled={!serialPort || usbIdentity?.usbMode !== "runtime" || serialBusy}><RotateCcw /> ERASE STORED CONFIGURATION</Button></AlertDialogTrigger><AlertDialogContent className="serial-dialog"><AlertDialogHeader><AlertDialogTitle>Erase network and device credentials?</AlertDialogTitle><AlertDialogDescription>This clears Wi-Fi settings, the server address, device identity, and permanent credential from the board. Firmware and the ESP32-S3 bridge are not changed.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void clearAgentConfiguration()}>ERASE CONFIGURATION</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </article>

      <article className="instrument-card agent-status-card">
        <div className="card-head"><div><p>SERVER-SIDE EVIDENCE</p><h2><Wifi /> Enrolled device status</h2></div><Button variant="ghost" size="sm" onClick={() => { if (selectedPhysical) void onRegistryRefresh(selectedPhysical.id).then(() => loadHardwareRecords(selectedPhysical.id)); }} disabled={!selectedPhysical}><RefreshCw /> REFRESH</Button></div>
        <label className="field-label">DEVICE<Select value={selectedPhysicalId} onValueChange={selectPhysical}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE" disabled>{physicalDevices.length ? "Select physical device" : "No physical devices enrolled"}</SelectItem>{physicalDevices.map((device) => <SelectItem value={device.id} key={device.id}>{device.name} · {device.connectionState}</SelectItem>)}</SelectContent></Select></label>
        {selectedPhysical ? <dl><div><dt>Connection</dt><dd className={`state-text ${selectedPhysical.connectionState.toLowerCase()}`}>{selectedPhysical.connectionState}</dd></div><div><dt>Agent</dt><dd>{selectedPhysical.agentVersion ?? "Awaiting heartbeat"}</dd></div><div><dt>Wi-Fi firmware</dt><dd>{selectedPhysical.firmwareVersion ?? "Awaiting heartbeat"}</dd></div><div><dt>Last seen</dt><dd>{relativeTime(selectedPhysical.lastSeenAt)}</dd></div></dl> : <div className="agent-empty"><AlertTriangle /><span>No physical device has enrolled with this workbench yet.</span></div>}
      </article>
    </div>

    <article className="instrument-card hil-card">
      <div className="card-head"><div><p>HARDWARE-IN-THE-LOOP</p><h2><Activity /> D7 → D2 validation record</h2></div>{activeRun ? <Badge variant="outline" className={`hil-status ${activeRun.status.toLowerCase()}`}>{activeRun.status}</Badge> : <Button onClick={() => void startHilRun()} disabled={!selectedPhysical}><Play /> START HIL RUN</Button>}</div>
      {!activeRun ? <div className="agent-empty"><ShieldCheck /><span>Connect D7 output to D2 input with the board unpowered, bring the physical agent online, then start the recorded procedure.</span></div> : <>
        <div className="hil-metrics"><div><small>TARGET</small><strong>{activeRun.targetCycles} cycles</strong></div><label className="field-label">COMPLETED<Input inputMode="numeric" value={cycles} onChange={(event) => setCycles(event.target.value.replace(/\D/g, ""))} onBlur={() => void updateRun({ completedCycles: Number(cycles), failureCount: Number(failures) })} /></label><label className="field-label">FAILURES<Input inputMode="numeric" value={failures} onChange={(event) => setFailures(event.target.value.replace(/\D/g, ""))} onBlur={() => void updateRun({ completedCycles: Number(cycles), failureCount: Number(failures) })} /></label><div><small>OPERATOR</small><strong>{activeRun.operator}</strong></div></div>
        <div className="hil-steps">{activeRun.steps.map((step) => <div key={step.stepKey}><span className={`hil-step-mark ${step.status.toLowerCase()}`}>{step.status === "PASSED" ? <Check /> : step.status === "FAILED" ? <X /> : "·"}</span><label><strong>{stepLabels[step.stepKey]}</strong><Input value={observations[step.stepKey] ?? ""} onChange={(event) => setObservations((current) => ({ ...current, [step.stepKey]: event.target.value }))} placeholder="Meter reading, observation, or recovery time" maxLength={240} /></label><div><Button variant="ghost" size="sm" onClick={() => void updateRun({ stepKey: step.stepKey, stepStatus: "PASSED" satisfies HilStepStatus, observation: observations[step.stepKey] ?? "" })}><Check /> PASS</Button><Button variant="ghost" size="sm" onClick={() => void updateRun({ stepKey: step.stepKey, stepStatus: "FAILED" satisfies HilStepStatus, observation: observations[step.stepKey] ?? "" })}><X /> FAIL</Button></div></div>)}</div>
        <footer><span>A pass is operator-attested evidence, not an automatic electrical measurement.</span>{activeRun.status !== "PASSED" && activeRun.status !== "ABORTED" && <Button variant="outline" onClick={() => void updateRun({ abort: true })}>ABORT RUN</Button>}</footer>
      </>}
      {runs.length > 1 && <small>{runs.length} retained runs for this device.</small>}
    </article>

    <article className="instrument-card agent-log-card">
      <div className="card-head"><div><p>SAFE AGENT LOGS</p><h2><Terminal /> Bounded, server-redacted events</h2></div><span>{logs.length} RECORDS</span></div>
      <Table><TableHeader><TableRow><TableHead>WHEN</TableHead><TableHead>LEVEL</TableHead><TableHead>CODE</TableHead><TableHead>MESSAGE</TableHead><TableHead>UPTIME</TableHead></TableRow></TableHeader><TableBody>{logs.slice(0, 30).map((log) => <TableRow key={log.id}><TableCell>{relativeTime(log.recordedAt)}</TableCell><TableCell className={log.level === "ERROR" ? "text-red" : log.level === "WARN" ? "amber-text" : "text-green"}>{log.level}</TableCell><TableCell><strong>{log.code}</strong></TableCell><TableCell>{log.message || "—"}</TableCell><TableCell>{log.deviceUptimeMs === null ? "—" : `${log.deviceUptimeMs} ms`}</TableCell></TableRow>)}{logs.length === 0 && <TableRow><TableCell colSpan={5} className="table-empty">No physical agent logs have been recorded.</TableCell></TableRow>}</TableBody></Table>
    </article>
  </section>;
}
