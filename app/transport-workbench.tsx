"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Clipboard, Clock3, KeyRound, Link2, LockKeyhole,
  Play, Radio, RefreshCw, RotateCcw, ShieldCheck, ShieldOff, StopCircle,
  Unplug, Wifi,
} from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APP_VERSION, type DeviceRecord, type EnrollmentTokenRecord, type TransportBundle } from "@/lib/device-model";

type SocketStatus = "IDLE" | "CONNECTING" | "AUTHENTICATED" | "RECONNECTING" | "STOPPED" | "FAILED";
type IssuedToken = { record: EnrollmentTokenRecord; secret: string; expiresInMinutes: number };
type SelfTestPayload = { device: DeviceRecord; credential: string; credentialId: string; socketPath: string; protocolVersion: number };
type GpioCommandMessage = {
  type: "gpio.command"; commandId: string; kind: "WRITE" | "WRITE_PWM" | "WRITE_DAC" | "SET_MODE"; pinId: string;
  requestedMode: "INPUT" | "INPUT_PULLUP" | "OUTPUT" | "ANALOG" | "PWM" | "DAC" | null; requestedValue: number | null;
};
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 8_000] as const;

type Props = {
  activeDevice: DeviceRecord | null;
  devices: DeviceRecord[];
  onSelectDevice(id: string): void;
  onBundle(bundle: TransportBundle): void;
  onRegistryRefresh(preferredId?: string): Promise<void>;
  notify(message: string): void;
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
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

function tokenState(token: EnrollmentTokenRecord, now = Date.now()) {
  if (token.revokedAt) return "REVOKED";
  if (token.usedAt) return "USED";
  if (token.expiresAt <= now) return "EXPIRED";
  return "READY";
}

function timeUntil(timestamp: number) {
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  return `${Math.ceil(seconds / 60)} min`;
}

export function TransportWorkbench({ activeDevice, devices, onSelectDevice, onBundle, onRegistryRefresh, notify }: Props) {
  const [tokens, setTokens] = useState<EnrollmentTokenRecord[]>([]);
  const [bundle, setBundle] = useState<TransportBundle | null>(null);
  const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
  const [deviceName, setDeviceName] = useState("UNO R4 Transport Test");
  const [ttlMinutes, setTtlMinutes] = useState("15");
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("IDLE");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [lastAckAt, setLastAckAt] = useState<number | null>(null);
  const [sequence, setSequence] = useState(0);
  const [canReconnect, setCanReconnect] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const commandPollTimerRef = useRef<number | null>(null);
  const snapshotReadyRef = useRef(false);
  const selfTestRef = useRef<SelfTestPayload | null>(null);
  const simulatedPinsRef = useRef<Record<string, { mode: string; value: number }>>(Object.fromEntries([
    ...Array.from({ length: 14 }, (_, index) => [`D${index}`, { mode: index === 5 ? "PWM" : "INPUT", value: 0 }] as const),
    ...Array.from({ length: 6 }, (_, index) => [`A${index}`, { mode: "ANALOG", value: 7_000 }] as const),
  ]));
  const stopRequestedRef = useRef(false);
  const mountedRef = useRef(true);

  const loadTokens = useCallback(async () => {
    const payload = await fetchJson<{ tokens: EnrollmentTokenRecord[] }>("/api/enrollment-tokens");
    setTokens(payload.tokens);
  }, []);

  const loadBundle = useCallback(async (deviceId: string) => {
    const payload = await fetchJson<TransportBundle>(`/api/devices/${encodeURIComponent(deviceId)}/transport`);
    setBundle(payload); onBundle(payload);
  }, [onBundle]);

  const selectedDeviceId = activeDevice?.id ?? null;
  useEffect(() => { window.queueMicrotask(() => { void loadTokens().catch(() => notify("Enrollment records could not be loaded")); }); }, [loadTokens, notify]);
  useEffect(() => {
    window.queueMicrotask(() => {
      if (!selectedDeviceId) { setBundle(null); return; }
      void loadBundle(selectedDeviceId).catch(() => notify("Transport state could not be loaded"));
    });
  }, [selectedDeviceId, loadBundle, notify]);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
    if (snapshotTimerRef.current) window.clearInterval(snapshotTimerRef.current);
    if (commandPollTimerRef.current) window.clearInterval(commandPollTimerRef.current);
    retryTimerRef.current = heartbeatTimerRef.current = snapshotTimerRef.current = commandPollTimerRef.current = null;
  }, []);

  const sendHeartbeat = useCallback((socket: WebSocket, seq: number) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "device.heartbeat", sequence: seq, uptimeMs: performance.now(),
      rssiDbm: -52 - Math.floor(Math.random() * 5), ipAddress: "192.168.1.90",
      agentVersion: `${APP_VERSION}-browser-sim`, firmwareVersion: `${APP_VERSION}-browser-sim`,
      localFailsafe: { mode: "SAFE_INPUT_BOOT", timeoutMs: null },
    }));
  }, []);

  const sendSnapshot = useCallback((socket: WebSocket, seq: number) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    simulatedPinsRef.current.A0.value = 6680 + Math.floor(Math.random() * 480);
    simulatedPinsRef.current.A1.value = 7600 + Math.floor(Math.random() * 700);
    socket.send(JSON.stringify({
      type: "device.snapshot", sequence: seq,
      pins: Object.entries(simulatedPinsRef.current).map(([pinId, pin]) => ({ pinId, mode: pin.mode, value: pin.value })),
    }));
  }, []);

  function connectSocket(payload: SelfTestPayload, attempt = 0) {
    clearTimers();
    snapshotReadyRef.current = false;
    if (!mountedRef.current || stopRequestedRef.current) return;
    setSocketStatus(attempt ? "RECONNECTING" : "CONNECTING"); setRetryAttempt(attempt);
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}${payload.socketPath}`);
    socketRef.current = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "device.authenticate", protocolVersion: payload.protocolVersion,
      deviceId: payload.device.id, credential: payload.credential,
    })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ({ type?: string; heartbeatIntervalMs?: number; sequence?: number; commandId?: string } | GpioCommandMessage);
      if (message.type === "device.authenticated") {
        setSocketStatus("AUTHENTICATED"); setRetryAttempt(0); setLastAckAt(Date.now());
        let nextSequence = 1;
        sendHeartbeat(socket, nextSequence); sendSnapshot(socket, nextSequence); setSequence(nextSequence);
        socket.send(JSON.stringify({ type: "device.log", level: "INFO", code: "SIMULATOR_READY", message: "Browser simulator authenticated", deviceUptimeMs: performance.now() }));
        heartbeatTimerRef.current = window.setInterval(() => { nextSequence += 1; setSequence(nextSequence); sendHeartbeat(socket, nextSequence); }, Math.max(4_000, message.heartbeatIntervalMs ?? 10_000));
        snapshotTimerRef.current = window.setInterval(() => sendSnapshot(socket, nextSequence), 12_000);
        commandPollTimerRef.current = window.setInterval(() => {
          if (snapshotReadyRef.current && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "device.command.poll" }));
        }, 300);
        void onRegistryRefresh(payload.device.id);
      } else if (message.type === "gpio.command") {
        const command = message as GpioCommandMessage;
        const current = simulatedPinsRef.current[command.pinId] ?? { mode: "INPUT", value: 0 };
        const confirmedMode = command.kind === "SET_MODE" && command.requestedMode ? command.requestedMode
          : command.kind === "WRITE" ? "OUTPUT" : command.kind === "WRITE_PWM" ? "PWM" : command.kind === "WRITE_DAC" ? "DAC" : current.mode;
        const confirmedValue = command.kind !== "SET_MODE" && command.requestedValue !== null ? command.requestedValue : current.value;
        simulatedPinsRef.current[command.pinId] = { mode: confirmedMode, value: confirmedValue };
        window.setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({
            type: "gpio.ack", commandId: command.commandId, pinId: command.pinId,
            confirmedMode, confirmedValue, deviceTimestampMs: Date.now(),
          }));
        }, 70 + Math.floor(Math.random() * 45));
      } else if (message.type === "device.snapshot.ack") {
        snapshotReadyRef.current = true;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "device.command.poll" }));
        setLastAckAt(Date.now());
        void loadBundle(payload.device.id).catch(() => undefined);
      } else if (message.type === "device.heartbeat.ack") {
        setLastAckAt(Date.now());
        void loadBundle(payload.device.id).catch(() => undefined);
      } else if (message.type === "gpio.ack.accepted") {
        setLastAckAt(Date.now());
        void loadBundle(payload.device.id).catch(() => undefined);
      } else if (message.type === "device.error") notify("Transport and GPIO simulator message was rejected");
    });
    socket.addEventListener("close", (event) => {
      clearTimers();
      snapshotReadyRef.current = false;
      if (!mountedRef.current || stopRequestedRef.current || event.code === 4003) {
        setSocketStatus(event.code === 4003 ? "FAILED" : "STOPPED");
        return;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt > RECONNECT_DELAYS.length) { setSocketStatus("FAILED"); notify("Transport and GPIO simulator stopped after five reconnect attempts"); return; }
      setSocketStatus("RECONNECTING"); setRetryAttempt(nextAttempt);
      retryTimerRef.current = window.setTimeout(() => connectSocket(payload, nextAttempt), RECONNECT_DELAYS[nextAttempt - 1] ?? 8_000);
    });
    socket.addEventListener("error", () => { /* close owns the bounded retry path */ });
  }

  useEffect(() => () => {
    mountedRef.current = false; stopRequestedRef.current = true; clearTimers();
    socketRef.current?.close(1000, "Transport screen closed");
  }, [clearTimers]);

  async function createToken() {
    try {
      const result = await fetchJson<IssuedToken>("/api/enrollment-tokens", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardProfileId: "arduino-uno-r4-wifi", deviceName, ttlMinutes: Number(ttlMinutes) }),
      });
      setIssuedToken(result); setTokenDialogOpen(false); await loadTokens();
      notify("One-time enrollment token created; its secret is shown once");
    } catch (error) { notify(error instanceof Error ? error.message : "Enrollment token was not created"); }
  }

  async function copySecret() {
    if (!issuedToken) return;
    try { await navigator.clipboard.writeText(issuedToken.secret); notify("Enrollment token copied"); }
    catch { notify("Clipboard access was blocked; select the token manually"); }
  }

  async function runSelfTest() {
    if (!issuedToken) return;
    try {
      stopRequestedRef.current = false;
      const payload = await fetchJson<SelfTestPayload>("/api/transport-self-test", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: issuedToken.secret }),
      });
      selfTestRef.current = payload; setCanReconnect(true); setIssuedToken(null); await loadTokens(); await onRegistryRefresh(payload.device.id);
      connectSocket(payload); notify("Enrollment exchanged; opening authenticated transport");
    } catch (error) { notify(error instanceof Error ? error.message : "Transport self-test did not start"); }
  }

  function stopSelfTest() {
    stopRequestedRef.current = true; clearTimers(); socketRef.current?.close(1000, "Operator stopped transport test");
    socketRef.current = null; setSocketStatus("STOPPED"); notify("Transport and GPIO simulator stopped");
  }

  function reconnectSelfTest() {
    const payload = selfTestRef.current; if (!payload) return;
    stopRequestedRef.current = false; connectSocket(payload); notify("Transport and GPIO simulator reconnecting");
  }

  async function revokeToken(id: string) {
    try { await fetchJson(`/api/enrollment-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }); await loadTokens(); notify("Unused enrollment token revoked"); }
    catch (error) { notify(error instanceof Error ? error.message : "Token was not revoked"); }
  }

  async function revokeCredential(credentialId: string) {
    if (!activeDevice) return;
    try {
      await fetchJson(`/api/devices/${encodeURIComponent(activeDevice.id)}/credentials/${encodeURIComponent(credentialId)}`, { method: "DELETE" });
      if (selfTestRef.current?.credentialId === credentialId) { stopSelfTest(); setCanReconnect(false); }
      await loadBundle(activeDevice.id); notify("Device credential revoked immediately");
    } catch (error) { notify(error instanceof Error ? error.message : "Credential was not revoked"); }
  }

  const liveSessions = bundle?.sessions.filter((session) => session.state === "CONNECTED").length ?? 0;
  const activeCredentials = bundle?.credentials.filter((credential) => !credential.revokedAt).length ?? 0;
  const retryProgress = socketStatus === "RECONNECTING" ? Math.min(100, retryAttempt * 20) : socketStatus === "AUTHENTICATED" ? 100 : 0;

  return <section className="content-screen transport-screen">
    <div className="page-heading"><div><p>DEVICE TRANSPORT / PROTOCOL 1</p><h1>Secure Transport</h1><span>Issue a one-time enrollment token, authenticate a device socket, and observe heartbeat-backed state live.</span></div><Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}><DialogTrigger asChild><Button><KeyRound /> CREATE ENROLLMENT TOKEN</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Create one-time enrollment token</DialogTitle><DialogDescription>The plaintext token is returned once, stored only as a SHA-256 hash, and expires automatically.</DialogDescription></DialogHeader><label className="field-label transport-field">DEVICE NAME<Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} /></label><label className="field-label transport-field">EXPIRES IN<Select value={ttlMinutes} onValueChange={setTtlMinutes}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="5">5 minutes</SelectItem><SelectItem value="15">15 minutes</SelectItem><SelectItem value="30">30 minutes</SelectItem><SelectItem value="60">60 minutes</SelectItem></SelectContent></Select></label><DialogFooter><Button variant="outline" onClick={() => setTokenDialogOpen(false)}>CANCEL</Button><Button onClick={() => void createToken()} disabled={!deviceName.trim()}><KeyRound /> CREATE TOKEN</Button></DialogFooter></DialogContent></Dialog></div>

    <div className="transport-boundary"><LockKeyhole /><div><strong>DEVICE GATEWAY BOUNDARY</strong><span>Physical agents connect to this host over TLS port 443. Only enrollment exchange and the authenticated WebSocket are anonymous-compatible; token issuance, records, controls, and every other operator API remain owner-gated.</span></div></div>

    {issuedToken && <article className="instrument-card issued-token-card"><div><span className="status-led amber" /><p>PLAINTEXT SHOWN ONCE</p><h2>{issuedToken.record.deviceName}</h2></div><code>{issuedToken.secret}</code><div className="issued-token-actions"><Button variant="outline" onClick={() => void copySecret()}><Clipboard /> COPY TOKEN</Button><Button onClick={() => void runSelfTest()}><Play /> RUN AUTHENTICATED TEST</Button></div><small>Expires in {issuedToken.expiresInMinutes} minutes. Running the test consumes this token.</small></article>}

    <section className="metric-strip transport-metrics"><article><span className="metric-icon green"><Link2 /></span><div><strong>{liveSessions}</strong><small>LIVE SESSIONS</small></div><em>HEARTBEAT BACKED</em></article><article><span className="metric-icon blue"><ShieldCheck /></span><div><strong>{activeCredentials}</strong><small>ACTIVE CREDENTIALS</small></div><em>INDIVIDUALLY REVOCABLE</em></article><article><span className="metric-icon amber"><RefreshCw /></span><div><strong>{retryAttempt}<small> / 5</small></strong><small>RECONNECT ATTEMPT</small></div><em>BOUNDED BACKOFF</em></article><article><span className="metric-icon graphite"><Clock3 /></span><div><strong>{relativeTime(lastAckAt)}</strong><small>LAST SOCKET ACK</small></div><em>SEQUENCE {sequence}</em></article></section>

    <div className="transport-grid">
      <article className="instrument-card transport-console"><div className="card-head"><div><p>AUTHENTICATED WEBSOCKET</p><h2>Transport and GPIO simulator</h2></div><Badge variant="outline" className={`transport-badge ${socketStatus.toLowerCase()}`}><span className={`status-led ${socketStatus === "AUTHENTICATED" ? "green" : socketStatus === "FAILED" ? "red" : socketStatus === "RECONNECTING" ? "amber" : "gray"}`} />{socketStatus}</Badge></div><div className="transport-path"><div><KeyRound /><strong>ENROLL</strong><small>SINGLE USE</small></div><i /><div><ShieldCheck /><strong>AUTHENTICATE</strong><small>HASH MATCH</small></div><i /><div><Activity /><strong>HEARTBEAT</strong><small>10 SECOND TARGET</small></div><i /><div><Radio /><strong>SNAPSHOT</strong><small>SERVER CONFIRMED</small></div></div><Progress value={retryProgress} aria-label="Transport connection progress" /><div className="transport-console-actions">{socketStatus === "AUTHENTICATED" || socketStatus === "CONNECTING" || socketStatus === "RECONNECTING" ? <Button variant="outline" onClick={stopSelfTest}><StopCircle /> STOP TEST</Button> : <Button variant="outline" onClick={reconnectSelfTest} disabled={!canReconnect}><RotateCcw /> RECONNECT TEST</Button>}<span>Backoff: 1 s → 2 s → 4 s → 8 s · maximum 5 attempts</span></div></article>

      <aside className="instrument-card transport-device-picker"><div className="card-head"><div><p>INSPECT DEVICE</p><h2>Transport records</h2></div><Radio /></div><label className="field-label">ACTIVE DEVICE<Select value={activeDevice?.id ?? "NONE"} onValueChange={onSelectDevice}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{devices.length === 0 && <SelectItem value="NONE" disabled>No registered devices</SelectItem>}{devices.map((device) => <SelectItem key={device.id} value={device.id}>{device.name} · {device.connectionState}</SelectItem>)}</SelectContent></Select></label>{activeDevice ? <dl><div><dt>Device ID</dt><dd>{activeDevice.id}</dd></div><div><dt>State</dt><dd className={`state-text ${activeDevice.connectionState.toLowerCase()}`}>{activeDevice.connectionState}</dd></div><div><dt>Last heartbeat</dt><dd>{relativeTime(bundle?.sessions[0]?.lastHeartbeatAt ?? null)}</dd></div><div><dt>Snapshots</dt><dd>{bundle?.snapshots.length ?? 0}</dd></div></dl> : <div className="table-empty">Select or enroll a device.</div>}</aside>
    </div>

    <article className="instrument-card transport-records"><Tabs defaultValue="credentials"><div className="transport-tabs-head"><TabsList variant="line"><TabsTrigger value="credentials"><KeyRound /> Credentials</TabsTrigger><TabsTrigger value="sessions"><Wifi /> Sessions</TabsTrigger><TabsTrigger value="snapshots"><Radio /> Snapshots</TabsTrigger><TabsTrigger value="commands"><Activity /> Commands</TabsTrigger><TabsTrigger value="tokens"><LockKeyhole /> Enrollment</TabsTrigger></TabsList><Button variant="ghost" size="sm" onClick={() => { void loadTokens(); if (activeDevice) void loadBundle(activeDevice.id); }}><RefreshCw /> REFRESH</Button></div><TabsContent value="credentials"><Table><TableHeader><TableRow><TableHead>CREDENTIAL</TableHead><TableHead>ISSUED</TableHead><TableHead>LAST USED</TableHead><TableHead>STATE</TableHead><TableHead /></TableRow></TableHeader><TableBody>{bundle?.credentials.map((credential) => <TableRow key={credential.id}><TableCell><strong>{credential.secretPrefix}</strong><small>{credential.id}</small></TableCell><TableCell>{relativeTime(credential.createdAt)}</TableCell><TableCell>{relativeTime(credential.lastUsedAt)}</TableCell><TableCell>{credential.revokedAt ? <span className="text-red">REVOKED</span> : <span className="text-green">ACTIVE</span>}</TableCell><TableCell>{!credential.revokedAt && <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="sm"><ShieldOff /> REVOKE</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Revoke this device credential?</AlertDialogTitle><AlertDialogDescription>Connected sessions using this credential will be closed and cannot authenticate again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void revokeCredential(credential.id)}>REVOKE CREDENTIAL</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</TableCell></TableRow>)}{!bundle?.credentials.length && <TableRow><TableCell colSpan={5} className="table-empty">No credentials for the selected device.</TableCell></TableRow>}</TableBody></Table></TabsContent><TabsContent value="sessions"><Table><TableHeader><TableRow><TableHead>SESSION</TableHead><TableHead>CONNECTED</TableHead><TableHead>LAST HEARTBEAT</TableHead><TableHead>STATE</TableHead><TableHead>CLOSE REASON</TableHead></TableRow></TableHeader><TableBody>{bundle?.sessions.map((session) => <TableRow key={session.id}><TableCell><strong>{session.id}</strong></TableCell><TableCell>{relativeTime(session.connectedAt)}</TableCell><TableCell>{relativeTime(session.lastHeartbeatAt)}</TableCell><TableCell>{session.state}</TableCell><TableCell>{session.closeReason || "—"}</TableCell></TableRow>)}{!bundle?.sessions.length && <TableRow><TableCell colSpan={5} className="table-empty">No authenticated sessions yet.</TableCell></TableRow>}</TableBody></Table></TabsContent><TabsContent value="snapshots"><Table><TableHeader><TableRow><TableHead>SEQUENCE</TableHead><TableHead>SESSION</TableHead><TableHead>RECORDED</TableHead><TableHead>PAYLOAD</TableHead></TableRow></TableHeader><TableBody>{bundle?.snapshots.map((snapshot) => <TableRow key={snapshot.id}><TableCell>#{snapshot.sequence}</TableCell><TableCell>{snapshot.sessionId ?? "—"}</TableCell><TableCell>{relativeTime(snapshot.recordedAt)}</TableCell><TableCell><code>{JSON.stringify(snapshot.payload)}</code></TableCell></TableRow>)}{!bundle?.snapshots.length && <TableRow><TableCell colSpan={4} className="table-empty">No state snapshots received.</TableCell></TableRow>}</TableBody></Table></TabsContent><TabsContent value="commands"><Table><TableHeader><TableRow><TableHead>COMMAND</TableHead><TableHead>PIN</TableHead><TableHead>STATUS</TableHead><TableHead>LATENCY</TableHead><TableHead>DETAIL</TableHead></TableRow></TableHeader><TableBody>{bundle?.commands.map((command) => <TableRow key={command.id}><TableCell><strong>{command.kind}</strong><small>{command.id}</small></TableCell><TableCell>{command.pinId}</TableCell><TableCell className={command.status === "ACKNOWLEDGED" ? "text-green" : command.status === "QUEUED" || command.status === "DELIVERED" ? "amber-text" : "text-red"}>{command.status}</TableCell><TableCell>{command.latencyMs === null ? "—" : `${command.latencyMs} ms`}</TableCell><TableCell>{command.error || (command.kind === "WRITE" ? `Requested ${command.requestedValue ? "HIGH" : "LOW"}` : `Requested ${command.requestedMode}`)}</TableCell></TableRow>)}{!bundle?.commands.length && <TableRow><TableCell colSpan={5} className="table-empty">No GPIO commands have been recorded.</TableCell></TableRow>}</TableBody></Table></TabsContent><TabsContent value="tokens"><Table><TableHeader><TableRow><TableHead>TOKEN</TableHead><TableHead>DEVICE NAME</TableHead><TableHead>EXPIRES</TableHead><TableHead>STATE</TableHead><TableHead /></TableRow></TableHeader><TableBody>{tokens.map((token) => { const state = tokenState(token); return <TableRow key={token.id}><TableCell><strong>{token.tokenPrefix}</strong><small>{token.id}</small></TableCell><TableCell>{token.deviceName}</TableCell><TableCell>{state === "READY" ? timeUntil(token.expiresAt) : relativeTime(token.expiresAt)}</TableCell><TableCell>{state}</TableCell><TableCell>{state === "READY" && <Button variant="ghost" size="sm" onClick={() => void revokeToken(token.id)}><Unplug /> REVOKE</Button>}</TableCell></TableRow>; })}{tokens.length === 0 && <TableRow><TableCell colSpan={5} className="table-empty">No enrollment tokens have been issued.</TableCell></TableRow>}</TableBody></Table></TabsContent></Tabs></article>
  </section>;
}
