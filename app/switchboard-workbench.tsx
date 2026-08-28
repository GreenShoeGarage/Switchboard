"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDownToLine, Check, ChevronRight,
  Clock3, Cpu, Database, Download, FolderPlus, Import, LayoutDashboard,
  ListFilter, LockKeyhole, LogOut, Microchip, Moon, MoreHorizontal,
  Network, Play, Plus, Radio, RefreshCw, Search, Server, Settings2,
  SlidersHorizontal, Sparkles, SquareActivity, Sun, Terminal, Trash2, Unplug,
  Wifi, WifiOff, Zap,
} from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { APP_VERSION, DATABASE_SCHEMA_VERSION, type ConnectionEvent, type DeviceGroup, type DevicePin, type DeviceRecord, type DeviceState, type GpioCommandKind, type GpioCommandRecord, type PinMode, type TransportBundle } from "@/lib/device-model";
import { TransportWorkbench } from "@/app/transport-workbench";
import { GpioCommandPanels } from "@/app/gpio-command-panels";
import { AgentWorkbench } from "@/app/agent-workbench";
import { TelemetryWorkbench } from "@/app/telemetry-workbench";
import { DeviceWorkbench, type DeviceWorkbenchTab } from "@/app/device-workbench";
import { AutomationWorkbench } from "@/app/automation-workbench";

type Screen = "dashboard" | "devices" | "transport" | "agent" | "pins" | "workbench" | "monitor" | "automation";
type SaveState = "saved" | "saving" | "unsaved";

const navItems: { id: Screen; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "devices", label: "Devices", icon: Microchip },
  { id: "transport", label: "Transport", icon: Radio },
  { id: "agent", label: "Provisioning", icon: Cpu },
  { id: "workbench", label: "Workbench", icon: SlidersHorizontal },
  { id: "monitor", label: "Monitor", icon: SquareActivity },
  { id: "automation", label: "Automation", icon: Zap },
];
const LIVE_RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 8_000] as const;

const previewDevice: DeviceRecord = {
  id: "SIM-UNO-R4-01", name: "Workshop Bench", boardProfileId: "arduino-uno-r4-wifi",
  boardName: "Arduino UNO R4 WiFi", kind: "SIMULATED", connectionState: "UNKNOWN",
  groupId: null, groupName: null, agentVersion: `${APP_VERSION}-sim`, firmwareVersion: `${APP_VERSION}-sim`,
  rssiDbm: null, ipAddress: null, lastSeenAt: null, lastConnectedAt: null,
  lastDisconnectedAt: null, simulated: true, maintenanceMode: false, monitorOnly: false, automationArmed: false, controlReady: true,
  firmwareFailsafeMode: "SAFE_INPUT_BOOT", firmwareFailsafeTimeoutMs: null, firmwareFailsafeReportedAt: null,
  configurationVersion: 1, createdAt: 0, updatedAt: 0,
};
const noPendingCommand = {
  confirmedRawValue: null, sampledAt: null,
  pendingCommandId: null, pendingCommandKind: null, requestedMode: null,
  requestedValue: null, pendingCommandStatus: null, requestedAt: null, commandDeadlineAt: null,
  serverSafeValue: null,
} as const;
const previewPins: DevicePin[] = [
  { ...noPendingCommand, deviceId: previewDevice.id, pinId: "D2", label: "Door Switch", mode: "INPUT_PULLUP", confirmedValue: 1, logicalLowLabel: "OPEN", logicalHighLabel: "CLOSED", engineeringUnit: null, scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "DIGITAL" },
  { ...noPendingCommand, deviceId: previewDevice.id, pinId: "D3", label: "Emergency Stop", mode: "INPUT", confirmedValue: 0, logicalLowLabel: "SAFE", logicalHighLabel: "TRIPPED", engineeringUnit: null, scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "DIGITAL · PWM" },
  { ...noPendingCommand, serverSafeValue: 0, deviceId: previewDevice.id, pinId: "D5", label: "Fan PWM", mode: "PWM", confirmedValue: 42, logicalLowLabel: null, logicalHighLabel: null, engineeringUnit: "%", scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "DIGITAL · PWM" },
  { ...noPendingCommand, serverSafeValue: 0, deviceId: previewDevice.id, pinId: "D7", label: "Pump Relay", mode: "OUTPUT", confirmedValue: 0, logicalLowLabel: "STOPPED", logicalHighLabel: "RUNNING", engineeringUnit: null, scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "DIGITAL" },
  { ...noPendingCommand, serverSafeValue: 0, deviceId: previewDevice.id, pinId: "D8", label: "Heater Enable", mode: "OUTPUT", confirmedValue: 0, logicalLowLabel: "DISABLED", logicalHighLabel: "ENABLED", engineeringUnit: null, scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "DIGITAL" },
  { ...noPendingCommand, deviceId: previewDevice.id, pinId: "A0", label: "Pressure", mode: "ANALOG", confirmedValue: 41.5, logicalLowLabel: null, logicalHighLabel: null, engineeringUnit: "PSI", scaleInputLow: .5, scaleOutputLow: 0, scaleInputHigh: 4.5, scaleOutputHigh: 100, capability: "ANALOG · DAC" },
  { ...noPendingCommand, deviceId: previewDevice.id, pinId: "A1", label: "Temperature", mode: "ANALOG", confirmedValue: 24.3, logicalLowLabel: null, logicalHighLabel: null, engineeringUnit: "°C", scaleInputLow: null, scaleOutputLow: null, scaleInputHigh: null, scaleOutputHigh: null, capability: "ANALOG" },
];

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `Request failed (${response.status})` })) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
function StatusLed({ tone = "green" }: { tone?: "green" | "amber" | "red" | "gray" | "blue" }) { return <span className={`status-led ${tone}`} aria-hidden="true" />; }
function stateTone(state: DeviceState): "green" | "amber" | "red" | "gray" { return state === "ONLINE" ? "green" : state === "RECONNECTING" ? "amber" : state === "OFFLINE" ? "red" : "gray"; }
function formatPinState(pin: DevicePin) {
  const value = pin.confirmedValue ?? 0;
  if (pin.mode === "ANALOG") return `${value.toFixed(3)} ${pin.engineeringUnit ?? "V"}`;
  if (pin.mode === "PWM") return `${((value / 4095) * 100).toFixed(1)}%`;
  if (pin.mode === "DAC") return `${((value / 4095) * 5).toFixed(3)} V`;
  return value ? pin.logicalHighLabel || "HIGH" : pin.logicalLowLabel || "LOW";
}
function relativeTime(timestamp: number | null) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "Just now"; if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60); return `${hours} hr ago`;
}
function normalizeScreen(screen: Screen): Screen { return screen === "pins" ? "workbench" : screen; }

export function SwitchboardWorkbench() {
  const [rawScreen, setScreen] = useState<Screen>("dashboard");
  const screen = normalizeScreen(rawScreen);
  const [automationDirty, setAutomationDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [lightTheme, setLightTheme] = useState(false);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [pins, setPins] = useState<DevicePin[]>(previewPins);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [selectedPin, setSelectedPin] = useState("D7");
  const [registryStatus, setRegistryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [pendingPin, setPendingPin] = useState<{ pinId: string; value?: number; mode?: PinMode } | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("ALL");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [sortOrder, setSortOrder] = useState("STATUS");
  const [notice, setNotice] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [history, setHistory] = useState([39.5, 40.2, 39.9, 41.1, 41.8, 41.4, 42.2, 41.5]);
  const [commands, setCommands] = useState<GpioCommandRecord[]>([]);
  const [liveLink, setLiveLink] = useState<"CONNECTING" | "LIVE" | "RECONNECTING" | "STOPPED">("CONNECTING");
  const [deviceWorkbenchTab, setDeviceWorkbenchTab] = useState<DeviceWorkbenchTab>("board");
  const importRef = useRef<HTMLInputElement>(null);
  const bootstrapped = useRef(false);

  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? (registryStatus === "loading" ? previewDevice : null);
  const selected = pins.find((pin) => pin.pinId === selectedPin) ?? pins[0] ?? previewPins[0];
  const online = activeDevice?.connectionState === "ONLINE";
  const controlBlockReason = !activeDevice ? "Device is unavailable"
    : activeDevice.maintenanceMode ? "Maintenance Mode blocks hardware-changing commands"
    : activeDevice.monitorOnly ? "Monitor Only blocks hardware-changing commands"
    : !online ? "Device must be online to confirm a command"
    : !activeDevice.simulated && !activeDevice.controlReady ? "A complete device snapshot must be accepted before control is enabled"
    : null;
  const controlBlocked = Boolean(controlBlockReason);
  const maintenance = controlBlocked;
  const pressure = pins.find((pin) => pin.pinId === "A0")?.confirmedValue ?? 0;

  const loadDeviceBundle = useCallback(async (id: string) => {
    const [pinPayload, eventPayload, commandPayload] = await Promise.all([
      fetchJson<{ pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(id)}/pins`),
      fetchJson<{ events: ConnectionEvent[] }>(`/api/devices/${encodeURIComponent(id)}/events`),
      fetchJson<{ commands: GpioCommandRecord[] }>(`/api/devices/${encodeURIComponent(id)}/commands`),
    ]);
    setPins(pinPayload.pins); setEvents(eventPayload.events); setCommands(commandPayload.commands);
    const a0 = pinPayload.pins.find((pin) => pin.pinId === "A0")?.confirmedValue;
    if (typeof a0 === "number") setHistory((current) => [...current.slice(-11), a0]);
  }, []);

  const applyTransportBundle = useCallback((bundle: TransportBundle) => {
    setDevices((current) => current.map((device) => device.id === bundle.device.id ? bundle.device : device));
    if (bundle.device.id === activeDeviceId) {
      setPins(bundle.pins); setEvents(bundle.events); setCommands(bundle.commands);
      const a0 = bundle.pins.find((pin) => pin.pinId === "A0")?.confirmedValue;
      if (typeof a0 === "number") setHistory((current) => current.at(-1) === a0 ? current : [...current.slice(-17), a0]);
    }
  }, [activeDeviceId]);

  const loadRegistry = useCallback(async (ensureSimulator = false) => {
    try {
      setRegistryStatus("loading"); setRegistryError(null);
      let [devicePayload, groupPayload] = await Promise.all([
        fetchJson<{ devices: DeviceRecord[] }>("/api/devices"),
        fetchJson<{ groups: DeviceGroup[] }>("/api/groups"),
      ]);
      if (ensureSimulator && devicePayload.devices.length === 0) {
        await fetchJson("/api/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "ensure-simulator" }) });
        [devicePayload, groupPayload] = await Promise.all([fetchJson("/api/devices"), fetchJson("/api/groups")]) as [{ devices: DeviceRecord[] }, { groups: DeviceGroup[] }];
      }
      setDevices(devicePayload.devices); setGroups(groupPayload.groups);
      const nextId = devicePayload.devices.some((device) => device.id === activeDeviceId) ? activeDeviceId! : devicePayload.devices[0]?.id ?? null;
      setActiveDeviceId(nextId);
      if (nextId) await loadDeviceBundle(nextId); else { setPins([]); setEvents([]); }
      setRegistryStatus("ready");
    } catch (error) {
      setRegistryStatus("error"); setRegistryError(error instanceof Error ? error.message : "Device registry could not be loaded");
    }
  }, [activeDeviceId, loadDeviceBundle]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (window.localStorage.getItem("switchboard-theme") === "light") setLightTheme(true);
      if (window.localStorage.getItem("switchboard-mode") === "advanced") setAdvanced(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!bootstrapped.current) { bootstrapped.current = true; void loadRegistry(false); }
  }, [loadRegistry]);
  useEffect(() => { window.localStorage.setItem("switchboard-theme", lightTheme ? "light" : "dark"); }, [lightTheme]);
  useEffect(() => { window.localStorage.setItem("switchboard-mode", advanced ? "advanced" : "easy"); }, [advanced]);
  useEffect(() => { if (rawScreen === "pins") window.queueMicrotask(() => setDeviceWorkbenchTab("board")); }, [rawScreen]);

  useEffect(() => {
    if (!activeDeviceId || registryStatus !== "ready") return;
    let source: EventSource | null = null; let retryTimer: number | null = null; let attempts = 0; let cancelled = false; let scheduled = false;
    const scheduleReconnect = () => {
      if (cancelled || scheduled) return; scheduled = true; source?.close();
      attempts += 1;
      if (attempts > LIVE_RECONNECT_DELAYS.length) { setLiveLink("STOPPED"); return; }
      setLiveLink("RECONNECTING");
      retryTimer = window.setTimeout(() => { scheduled = false; connect(); }, LIVE_RECONNECT_DELAYS[attempts - 1] ?? 8_000);
    };
    const connect = () => {
      if (cancelled) return;
      source = new EventSource(`/api/devices/${encodeURIComponent(activeDeviceId)}/stream`);
      source.addEventListener("open", () => { attempts = 0; scheduled = false; setLiveLink("LIVE"); });
      source.addEventListener("snapshot", (event) => {
        try { applyTransportBundle(JSON.parse((event as MessageEvent).data) as TransportBundle); setLiveLink("LIVE"); }
        catch { scheduleReconnect(); }
      });
      source.addEventListener("heartbeat", () => setLiveLink("LIVE"));
      source.addEventListener("reconnect", scheduleReconnect);
      source.addEventListener("stream-error", scheduleReconnect);
      source.onerror = scheduleReconnect;
    };
    window.queueMicrotask(connect);
    return () => { cancelled = true; source?.close(); if (retryTimer) window.clearTimeout(retryTimer); };
  }, [activeDeviceId, registryStatus, applyTransportBundle]);

  useEffect(() => {
    if (!activeDevice?.id.startsWith("SIM-") || activeDevice.connectionState !== "ONLINE" || registryStatus !== "ready") return;
    const tick = window.setInterval(async () => {
      try {
        const payload = await fetchJson<{ device: DeviceRecord; pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "tick" }) });
        setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device)); setPins(payload.pins);
        const nextPressure = payload.pins.find((pin) => pin.pinId === "A0")?.confirmedValue;
        if (typeof nextPressure === "number") setHistory((current) => [...current.slice(-17), nextPressure]);
      } catch { /* the connection-state screen remains authoritative */ }
    }, 2800);
    return () => window.clearInterval(tick);
  }, [activeDevice?.id, activeDevice?.simulated, activeDevice?.agentVersion, activeDevice?.connectionState, registryStatus]);

  const flashNotice = useCallback((message: string, duration = 2800) => { setNotice(message); window.setTimeout(() => setNotice(null), duration); }, []);
  const refreshTransportRegistry = useCallback(async (preferredId?: string) => {
    const [devicePayload, groupPayload] = await Promise.all([
      fetchJson<{ devices: DeviceRecord[] }>("/api/devices"), fetchJson<{ groups: DeviceGroup[] }>("/api/groups"),
    ]);
    setDevices(devicePayload.devices); setGroups(groupPayload.groups);
    const nextId = preferredId && devicePayload.devices.some((device) => device.id === preferredId)
      ? preferredId : devicePayload.devices.some((device) => device.id === activeDeviceId) ? activeDeviceId : devicePayload.devices[0]?.id ?? null;
    setActiveDeviceId(nextId);
    if (nextId) await loadDeviceBundle(nextId);
  }, [activeDeviceId, loadDeviceBundle]);
  function navigateTo(destination: Screen) {
    if (screen === "automation" && destination !== "automation" && automationDirty
      && !window.confirm("Discard the unsaved automation draft?")) return;
    if (destination !== "automation") setAutomationDirty(false);
    setScreen(destination);
  }
  async function selectDevice(id: string, destination?: Screen) { setActiveDeviceId(id); await loadDeviceBundle(id); if (destination) navigateTo(destination); }
  async function saveDevicePatch(patch: { name?: string; groupId?: string | null; maintenanceMode?: boolean; monitorOnly?: boolean; automationArmed?: boolean }) {
    if (!activeDevice || registryStatus !== "ready") return;
    try {
      setSaveState("saving");
      const payload = await fetchJson<{ device: DeviceRecord }>(`/api/devices/${encodeURIComponent(activeDevice.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device));
      setSaveState("saved"); flashNotice("Device configuration saved");
    } catch (error) { setSaveState("unsaved"); flashNotice(error instanceof Error ? error.message : "Configuration was not saved"); }
  }
  function updateDeviceName(value: string) {
    if (!activeDevice) return; setSaveState("unsaved");
    setDevices((current) => current.map((device) => device.id === activeDevice.id ? { ...device, name: value } : device));
  }
  async function createGroup() {
    const name = newGroupName.trim(); if (!name) return;
    try {
      const payload = await fetchJson<{ groups: DeviceGroup[]; id: string }>("/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      setGroups(payload.groups); setNewGroupName(""); setGroupDialogOpen(false); await saveDevicePatch({ groupId: payload.id }); flashNotice(`Group created: ${name}`);
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Group was not created"); }
  }
  async function createSimulator() {
    try {
      const payload = await fetchJson<{ device: DeviceRecord }>("/api/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create-simulator", name: `Simulator ${devices.length + 1}` }) });
      await loadRegistry(false); await selectDevice(payload.device.id, "devices"); flashNotice("Server-managed simulator created");
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Simulator was not created"); }
  }
  async function clearSampleDevice() {
    if (!activeDevice?.simulated) return;
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(activeDevice.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Sample device was not cleared");
      setActiveDeviceId(null); await loadRegistry(false); flashNotice("Simulated sample device cleared");
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Sample device was not cleared"); }
  }
  async function setSimulatorState(state: DeviceState) {
    if (!activeDevice?.simulated) return;
    const payload = await fetchJson<{ device: DeviceRecord }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set-state", state }) });
    if (payload.device) setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device));
    await loadDeviceBundle(activeDevice.id);
  }
  async function toggleSimulatorConnection() {
    if (!activeDevice?.simulated) return;
    try {
      if (activeDevice.connectionState === "ONLINE") { await setSimulatorState("OFFLINE"); flashNotice("Simulator is offline; commands are blocked"); }
      else {
        await setSimulatorState("RECONNECTING"); flashNotice("Simulator reconnecting…");
        window.setTimeout(async () => { try { await setSimulatorState("ONLINE"); flashNotice("Simulator reconnected and state refreshed"); } catch { flashNotice("Simulator reconnection failed"); } }, 850);
      }
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Connection state did not change"); }
  }
  function mergeCommand(command: GpioCommandRecord) {
    setCommands((current) => [command, ...current.filter((item) => item.id !== command.id)].sort((a, b) => b.requestedAt - a.requestedAt).slice(0, 40));
  }
  async function waitForCommand(commandId: string, maximumAttempts = 26) {
    if (!activeDevice) throw new Error("Device is unavailable");
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 240));
      const payload = await fetchJson<{ command: GpioCommandRecord; pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/commands?commandId=${encodeURIComponent(commandId)}`);
      setPins(payload.pins); mergeCommand(payload.command);
      if (!["QUEUED", "DELIVERED"].includes(payload.command.status)) return payload.command;
    }
    throw new Error("Command status could not be confirmed");
  }
  async function runGpioCommand(input: { kind: GpioCommandKind; pinId: string; requestedValue?: number; requestedMode?: PinMode }) {
    if (!activeDevice || pendingPin) return;
    if (controlBlocked) { flashNotice(controlBlockReason ?? "Hardware control is blocked"); return; }
    setPendingPin({ pinId: input.pinId, value: input.requestedValue, mode: input.requestedMode });
    try {
      const payload = await fetchJson<{ command: GpioCommandRecord; pins: DevicePin[]; commands: GpioCommandRecord[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/commands`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      setPins(payload.pins); setCommands(payload.commands);
      const command = ["QUEUED", "DELIVERED"].includes(payload.command.status) ? await waitForCommand(payload.command.id) : payload.command;
      if (command.status !== "ACKNOWLEDGED") throw new Error(command.error || `Command ${command.status.toLowerCase()}`);
      const outcome = input.kind === "WRITE" ? `${input.requestedValue ? "HIGH" : "LOW"} confirmed`
        : input.kind === "WRITE_PWM" ? `${(((input.requestedValue ?? 0) / 4095) * 100).toFixed(1)}% PWM confirmed`
        : input.kind === "WRITE_DAC" ? `${(((input.requestedValue ?? 0) / 4095) * 5).toFixed(3)} V DAC confirmed`
        : `${input.requestedMode?.replace("_", " ")} confirmed`;
      flashNotice(`${input.pinId} ${outcome} · ${command.latencyMs ?? 0} ms`);
    } catch (error) { flashNotice(error instanceof Error ? error.message : "GPIO command failed", 3400); }
    finally { setPendingPin(null); if (activeDevice) void loadDeviceBundle(activeDevice.id); }
  }
  async function commandPin(pinId: string, value: number) {
    await runGpioCommand({ kind: "WRITE", pinId, requestedValue: value });
  }
  async function changeMode(pinId: string, mode: PinMode) {
    if (!activeDevice) return;
    if (controlBlocked) { flashNotice(controlBlockReason ?? "Hardware control is blocked"); return; }
    await runGpioCommand({ kind: "SET_MODE", pinId, requestedMode: mode });
  }
  function updatePinDraft(pinId: string, patch: Partial<Pick<DevicePin, "label" | "logicalLowLabel" | "logicalHighLabel">>) {
    setSaveState("unsaved");
    setPins((current) => current.map((pin) => pin.pinId === pinId ? { ...pin, ...patch } : pin));
  }
  async function savePinMetadata(pinId: string, patch: Partial<Pick<DevicePin, "label" | "logicalLowLabel" | "logicalHighLabel">>) {
    if (!activeDevice) return;
    try {
      setSaveState("saving");
      const payload = await fetchJson<{ device: DeviceRecord; pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/pins`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinId, ...patch }),
      });
      setPins(payload.pins); setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device));
      setSaveState("saved"); flashNotice(`${pinId} labels saved`);
    } catch (error) { setSaveState("unsaved"); flashNotice(error instanceof Error ? error.message : "Pin labels were not saved"); }
  }
  async function saveServerSafeValue(pinId: string, serverSafeValue: number | null) {
    if (!activeDevice) throw new Error("Device is unavailable");
    const payload = await fetchJson<{ device: DeviceRecord; pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/pins`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinId, serverSafeValue }),
    });
    setPins(payload.pins);
    setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device));
  }
  async function applyServerSafeState() {
    if (!activeDevice) throw new Error("Device is unavailable");
    const payload = await fetchJson<{ commands: GpioCommandRecord[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/safe-state`, { method: "POST" });
    for (const command of payload.commands) mergeCommand(command);
    const terminal = await Promise.all(payload.commands.map((command) => ["QUEUED", "DELIVERED"].includes(command.status) ? waitForCommand(command.id, 80) : command));
    const failed = terminal.find((command) => command.status !== "ACKNOWLEDGED");
    await loadDeviceBundle(activeDevice.id);
    if (failed) throw new Error(failed.error || `Safe-state command for ${failed.pinId} ${failed.status.toLowerCase()}`);
    flashNotice(`Server safe state acknowledged on ${terminal.length} target${terminal.length === 1 ? "" : "s"}`);
  }
  async function exportConfiguration() {
    if (!activeDevice) return;
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(activeDevice.id)}/configuration`); if (!response.ok) throw new Error("Configuration export failed");
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `switchboard-${activeDevice.id.toLowerCase()}.json`; anchor.click(); URL.revokeObjectURL(url); flashNotice("Persistent non-secret configuration exported");
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Configuration export failed"); }
  }
  async function importConfiguration(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file || !activeDevice) return;
    try {
      const parsed = JSON.parse(await file.text());
      const payload = await fetchJson<{ device: DeviceRecord; pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(activeDevice.id)}/configuration`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed) });
      setDevices((current) => current.map((device) => device.id === payload.device.id ? payload.device : device)); setPins(payload.pins); flashNotice("Configuration validated, imported, and saved");
    } catch (error) { flashNotice(error instanceof Error ? error.message : "Import rejected", 3400); }
    event.target.value = "";
  }

  const filteredDevices = useMemo(() => devices.filter((device) => {
    const matchesSearch = `${device.name} ${device.id} ${device.boardName} ${device.groupName ?? ""}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (stateFilter === "ALL" || device.connectionState === stateFilter) && (groupFilter === "ALL" || (groupFilter === "UNGROUPED" ? !device.groupId : device.groupId === groupFilter));
  }).sort((a, b) => sortOrder === "NAME" ? a.name.localeCompare(b.name) : sortOrder === "RECENT" ? (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) : ["ONLINE", "RECONNECTING", "OFFLINE", "UNKNOWN"].indexOf(a.connectionState) - ["ONLINE", "RECONNECTING", "OFFLINE", "UNKNOWN"].indexOf(b.connectionState)), [devices, search, stateFilter, groupFilter, sortOrder]);
  const visiblePins = pins.filter((pin) => `${pin.pinId} ${pin.label} ${pin.mode}`.toLowerCase().includes(search.toLowerCase()));
  const connectedCount = devices.filter((device) => device.connectionState === "ONLINE").length;
  const chartPoints = history.map((value, index) => `${((index / Math.max(history.length - 1, 1)) * 680).toFixed(1)},${Math.max(8, Math.min(118, 120 - ((value - 38) / 7) * 100)).toFixed(1)}`).join(" ");
  function openDeviceWorkbench(tab: DeviceWorkbenchTab) { setDeviceWorkbenchTab(tab); navigateTo("workbench"); }

  return <div className={lightTheme ? "switchboard-app light" : "switchboard-app"}>
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon" className="instrument-sidebar">
        <SidebarHeader className="brand-block"><div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div><div className="brand-copy"><strong>SWITCHBOARD</strong><span>v{APP_VERSION}</span></div></SidebarHeader>
        <SidebarContent><SidebarGroup><SidebarGroupLabel>WORKBENCH</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{navItems.map((item) => <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.label} isActive={screen === item.id} onClick={() => navigateTo(item.id)}><item.icon /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          {advanced && <SidebarGroup><SidebarGroupLabel>ADVANCED</SidebarGroupLabel><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton tooltip="Agent logs" onClick={() => openDeviceWorkbench("logs")}><Terminal /><span>Agent Logs</span></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton tooltip="Board profile" onClick={() => openDeviceWorkbench("details")}><Cpu /><span>Board Profile</span></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton tooltip="Server health" onClick={() => navigateTo("transport")}><Server /><span>Server Health</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>}
        </SidebarContent>
        <SidebarFooter className="sidebar-foot"><div className="server-mini"><StatusLed tone={registryStatus === "ready" ? "green" : registryStatus === "loading" ? "amber" : "red"} /><span><strong>REGISTRY</strong><small>{registryStatus === "ready" ? "PERSISTENT" : registryStatus.toUpperCase()}</small></span><span className="latency">SQLITE</span></div><p>Self-hosted instrument · local operator sessions</p></SidebarFooter>
      </Sidebar>
      <SidebarInset className="instrument-main">
        <header className="topbar"><div className="topbar-left"><SidebarTrigger aria-label="Toggle navigation" /><div className="title-lockup"><span>SWITCHBOARD</span><small>MICROCONTROLLER COMMAND WORKBENCH</small></div></div><div className="topbar-actions"><div className="mode-control"><span className={!advanced ? "active" : ""}>EASY</span><Switch checked={advanced} onCheckedChange={setAdvanced} aria-label="Toggle Advanced Mode" /><span className={advanced ? "active" : ""}>ADVANCED</span></div><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setLightTheme((value) => !value)} aria-label={lightTheme ? "Use dark theme" : "Use light theme"}>{lightTheme ? <Moon /> : <Sun />}</Button></TooltipTrigger><TooltipContent>{lightTheme ? "Dark theme" : "Light theme"}</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><form method="post" action="/api/auth/logout"><Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out"><LogOut /></Button></form></TooltipTrigger><TooltipContent>Sign out</TooltipContent></Tooltip>
          <Button className="add-device" onClick={() => navigateTo("agent")}><Plus /> ADD DEVICE</Button>
        </div></header>
        {notice && <div className="instrument-toast" role="status"><Check /> {notice}</div>}
        <main className="workspace">
          {registryStatus === "error" && <div className="registry-error"><Database /><span><strong>DEVICE REGISTRY UNAVAILABLE</strong>{registryError}</span><Button variant="outline" onClick={() => void loadRegistry(false)}><RefreshCw /> RETRY</Button></div>}
          {registryStatus === "loading" && <div className="registry-loading"><Skeleton className="h-3 w-40" /><span>SYNCING PERSISTENT DEVICE REGISTRY…</span></div>}
          {registryStatus === "ready" && devices.length === 0 && <section className="empty-registry instrument-card"><Database /><p>DEVICE REGISTRY</p><h1>No devices are registered.</h1><span>Create a clearly labeled simulator for development or connect a physical board when provisioning is available.</span><div><Button onClick={() => void createSimulator()}><Sparkles /> CREATE SIMULATOR</Button><Button variant="outline" onClick={() => setScreen("devices")}><Settings2 /> REGISTRY</Button></div></section>}

          {screen === "dashboard" && activeDevice && <>
            <section className="page-heading"><div><p>FIELD INSTRUMENT / BATCH 8</p><h1>Structured automation with hard safety gates.</h1><span>Threshold, interval, and UTC schedule rules now connect confirmed state to absolute output actions through revision approval, dry runs, explicit device permission, cooldowns, rate limits, loop protection, and acknowledged command evidence.</span></div><div className="heading-tools"><Button variant="outline" onClick={() => setScreen("automation")}><Zap /> OPEN AUTOMATION</Button><Button variant="outline" onClick={() => openDeviceWorkbench("board")}><SlidersHorizontal /> OPEN WORKBENCH</Button><Button variant="outline" onClick={() => setScreen("monitor")}><SquareActivity /> OPEN MONITOR</Button><input ref={importRef} className="sr-only" type="file" accept="application/json" onChange={importConfiguration} /><Button variant="outline" onClick={() => importRef.current?.click()}><Import /> IMPORT</Button><Button variant="outline" onClick={() => void exportConfiguration()}><Download /> EXPORT</Button></div></section>
            <section className="metric-strip"><article><span className="metric-icon green"><Microchip /></span><div><strong>{connectedCount}<small> / {devices.length}</small></strong><small>CONNECTED DEVICES</small></div><em>{devices.filter((d) => d.simulated).length} SIMULATED</em></article><article><span className="metric-icon amber"><Database /></span><div><strong>{activeDevice.configurationVersion}</strong><small>CONFIGURATION VERSION</small></div><em>PERSISTED</em></article><article><span className="metric-icon blue"><Radio /></span><div><strong>{activeDevice.rssiDbm ?? "—"}<small> dBm</small></strong><small>DEVICE SIGNAL</small></div><em>{online ? "LIVE" : "STALE"}</em></article><article><span className="metric-icon graphite"><Clock3 /></span><div><strong>{relativeTime(activeDevice.lastSeenAt)}</strong><small>LAST SEEN</small></div><em>SERVER TIME</em></article></section>
            <section className="dashboard-grid"><article className="instrument-card device-card"><div className="card-head"><div><p>ACTIVE DEVICE</p><h2>{activeDevice.name}</h2></div>{activeDevice.simulated && <span className="sample-tag"><Sparkles /> SIMULATED DEVICE</span>}</div><div className="device-status-row"><div className={`device-orbit ${online ? "online" : "offline"}`}><Cpu /><span><i /><i /><i /><i /><i /><i /></span></div><div className="device-summary"><span className={`state-badge ${activeDevice.connectionState.toLowerCase()}`}><StatusLed tone={stateTone(activeDevice.connectionState)} />{activeDevice.connectionState}</span><h3>{activeDevice.boardName}</h3><p>{activeDevice.id} · Agent {activeDevice.agentVersion ?? "—"}</p><div className="summary-readouts"><span><Wifi />{activeDevice.rssiDbm ?? "—"} dBm</span><span><Network />{activeDevice.ipAddress ?? "No current address"}</span><span><Database />{activeDevice.groupName ?? "Ungrouped"}</span></div></div></div><div className="device-actions"><Button variant="outline" onClick={() => openDeviceWorkbench("board")}><SlidersHorizontal /> OPEN DEVICE WORKBENCH</Button><Button variant="ghost" onClick={() => openDeviceWorkbench("details")}><Settings2 /> DETAILS</Button><Button variant="ghost" onClick={() => setScreen("transport")}><Radio /> TRANSPORT</Button>{activeDevice.id.startsWith("SIM-") && <Button variant="ghost" onClick={() => void toggleSimulatorConnection()}>{online ? <Unplug /> : <Play />}{online ? "SIMULATE OFFLINE" : "RECONNECT"}</Button>}</div></article>
              <article className="instrument-card quick-control"><div className="card-head"><div><p>QUICK CONTROL</p><h2>Output channels</h2></div><span className="live-tag"><StatusLed tone={stateTone(activeDevice.connectionState)} />{online ? "LIVE" : "STALE"}</span></div><div className="quick-list">{pins.filter((pin) => pin.mode === "OUTPUT").slice(0, 4).map((pin) => <div className="quick-row" key={pin.pinId}><button onClick={() => { setSelectedPin(pin.pinId); openDeviceWorkbench("board"); }}><strong>{pin.pinId}</strong><span>{pin.label || "Unlabeled pin"}<small>DIGITAL OUTPUT</small></span></button><div className="command-control"><span className={pendingPin?.pinId === pin.pinId ? "pending" : pin.confirmedValue ? "high" : "low"}>{pendingPin?.pinId === pin.pinId ? `REQUESTED ${pendingPin.value ? "HIGH" : "LOW"}` : pin.confirmedValue ? "HIGH" : "LOW"}</span><Switch checked={Boolean(pendingPin?.pinId === pin.pinId ? pendingPin.value : pin.confirmedValue)} onCheckedChange={(value) => void commandPin(pin.pinId, value ? 1 : 0)} disabled={controlBlocked || Boolean(pendingPin)} aria-label={`Set ${pin.pinId}`} /></div></div>)}</div>{!online && <div className="stale-note"><WifiOff /> {activeDevice.connectionState}. Commands are disabled; values are last confirmed.</div>}{controlBlocked && online && <div className="stale-note amber"><LockKeyhole /> {controlBlockReason}</div>}</article>
              <article className="instrument-card analog-card"><div className="card-head"><div><p>LIVE STATE STREAM</p><h2>A0 — Pressure</h2></div><button onClick={() => setScreen("monitor")}>OPEN MONITOR <ChevronRight /></button></div><div className="analog-readout"><strong>{pressure.toFixed(1)}</strong><span>PSI<small>{liveLink} BROWSER LINK</small></span></div><div className="spark-chart"><svg viewBox="0 0 680 128" preserveAspectRatio="none"><polyline className="chart-line" points={chartPoints} /></svg></div><div className="chart-foot"><span>SNAPSHOT</span><span>NOW</span><strong>SERVER CONFIRMED</strong></div></article>
              <article className="instrument-card activity-card"><div className="card-head"><div><p>CONNECTION HISTORY</p><h2>Durable state transitions</h2></div><span>{events.length} EVENTS</span></div><div className="activity-list">{events.slice(0, 4).map((event) => <div key={event.id}><span className="activity-check"><StatusLed tone={stateTone(event.state)} /></span><span><strong>{event.state}</strong><small>{event.reason} · {relativeTime(event.occurredAt)}</small></span><em>#{event.id}</em></div>)}</div></article></section>
          </>}

          {screen === "devices" && <section className="content-screen"><div className="page-heading"><div><p>DEVICE REGISTRY / DATABASE SCHEMA {DATABASE_SCHEMA_VERSION}</p><h1>Devices</h1><span>Search, filter, sort, group, and persist every registered instrument.</span></div><Button onClick={() => void createSimulator()}><Sparkles /> ADD SIMULATOR</Button></div><div className="device-detail-grid"><article className="instrument-card registry-card"><div className="registry-filters"><label><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search devices, boards, or groups" /></label><Select value={stateFilter} onValueChange={setStateFilter}><SelectTrigger><ListFilter /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All states</SelectItem><SelectItem value="ONLINE">Online</SelectItem><SelectItem value="RECONNECTING">Reconnecting</SelectItem><SelectItem value="OFFLINE">Offline</SelectItem><SelectItem value="UNKNOWN">Unknown</SelectItem></SelectContent></Select><Select value={groupFilter} onValueChange={setGroupFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All groups</SelectItem><SelectItem value="UNGROUPED">Ungrouped</SelectItem>{groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select><Select value={sortOrder} onValueChange={setSortOrder}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="STATUS">Sort by status</SelectItem><SelectItem value="NAME">Sort by name</SelectItem><SelectItem value="RECENT">Sort by last seen</SelectItem></SelectContent></Select></div><div className="device-table-row header"><span>DEVICE</span><span>BOARD</span><span>STATUS</span><span>GROUP</span><span>AGENT</span><span /></div>{filteredDevices.map((device) => <div key={device.id} className={`device-table-row ${device.id === activeDeviceId ? "selected" : ""}`}><button className="device-row-select" onClick={() => void selectDevice(device.id)}><span><StatusLed tone={stateTone(device.connectionState)} /><strong>{device.name}</strong><small>{device.id}</small></span><span>{device.boardName.replace("Arduino ", "")}<small>{device.simulated ? "SIMULATED" : "PHYSICAL"}</small></span><span className={`state-text ${device.connectionState.toLowerCase()}`}>{device.connectionState}</span><span>{device.groupName ?? "Ungrouped"}</span><span>{device.agentVersion ?? "—"}</span></button><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="device-row-menu" aria-label={`Actions for ${device.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>{device.name}</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void selectDevice(device.id)}><Settings2 /> VIEW DETAILS</DropdownMenuItem><DropdownMenuItem onSelect={() => void selectDevice(device.id, "workbench")}><SlidersHorizontal /> OPEN WORKBENCH</DropdownMenuItem><DropdownMenuItem onSelect={() => void selectDevice(device.id, "monitor")}><SquareActivity /> OPEN MONITOR</DropdownMenuItem><DropdownMenuItem onSelect={() => void selectDevice(device.id, "transport")}><Radio /> OPEN TRANSPORT</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>)}{filteredDevices.length === 0 && <div className="table-empty">No devices match the current filters.</div>}</article>
              {activeDevice && <aside className="instrument-card identity-card"><div className="card-head"><div><p>DEVICE CONFIGURATION</p><h2>Identity</h2></div><span className={`save-state ${saveState}`}><StatusLed tone={saveState === "saved" ? "green" : "amber"} />{saveState.toUpperCase()}</span></div><label className="field-label">DEVICE NAME<Input value={activeDevice.name} onChange={(event) => updateDeviceName(event.target.value)} onBlur={() => void saveDevicePatch({ name: activeDevice.name })} maxLength={80} /></label><div className="group-picker"><label className="field-label">DEVICE GROUP<Select value={activeDevice.groupId ?? "UNGROUPED"} onValueChange={(value) => void saveDevicePatch({ groupId: value === "UNGROUPED" ? null : value })}><SelectTrigger className="wide"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="UNGROUPED">Ungrouped</SelectItem>{groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent></Select></label><Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}><DialogTrigger asChild><Button variant="outline" size="icon-sm" aria-label="Create group"><FolderPlus /></Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Create device group</DialogTitle><DialogDescription>Groups organize instruments without changing their identities.</DialogDescription></DialogHeader><Input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Example: Greenhouse" maxLength={60} /><DialogFooter><Button variant="outline" onClick={() => setGroupDialogOpen(false)}>CANCEL</Button><Button onClick={() => void createGroup()} disabled={!newGroupName.trim()}>CREATE GROUP</Button></DialogFooter></DialogContent></Dialog></div><dl><div><dt>Device ID</dt><dd>{activeDevice.id}</dd></div><div><dt>Board profile</dt><dd>{activeDevice.boardProfileId}</dd></div><div><dt>Configuration</dt><dd>Version {activeDevice.configurationVersion}</dd></div><div><dt>Last seen</dt><dd>{relativeTime(activeDevice.lastSeenAt)}</dd></div></dl><div className="section-rule" /><div className="maintenance-row"><span><LockKeyhole /><span><strong>Maintenance Mode</strong><small>Persistently block hardware-changing commands.</small></span></span><Switch checked={activeDevice.maintenanceMode} onCheckedChange={(checked) => void saveDevicePatch({ maintenanceMode: checked })} /></div><Button variant="outline" className="wide" onClick={() => void exportConfiguration()}><ArrowDownToLine /> EXPORT CONFIGURATION</Button>{activeDevice.simulated && <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" className="wide danger-action"><Trash2 /> CLEAR SAMPLE DATA</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Clear this simulated device?</AlertDialogTitle><AlertDialogDescription>The device, pin configuration, and connection history will be permanently removed. Physical devices cannot be deleted with this action.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void clearSampleDevice()}>CLEAR SAMPLE DATA</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</aside>}</div></section>}

          {screen === "transport" && <TransportWorkbench activeDevice={activeDevice} devices={devices} onSelectDevice={(id) => void selectDevice(id)} onBundle={applyTransportBundle} onRegistryRefresh={refreshTransportRegistry} notify={flashNotice} />}
          {screen === "agent" && <AgentWorkbench activeDevice={activeDevice} devices={devices} onSelectDevice={(id) => void selectDevice(id)} onRegistryRefresh={refreshTransportRegistry} notify={flashNotice} />}
          {screen === "workbench" && activeDevice && <DeviceWorkbench key={activeDevice.id} device={activeDevice} pins={pins} events={events} commands={commands} selectedPinId={selectedPin} pendingPin={pendingPin} advanced={advanced} tab={deviceWorkbenchTab} onTabChange={setDeviceWorkbenchTab} onSelectPin={setSelectedPin} onDigitalCommand={commandPin} onModeChange={changeMode} onAnalogOutput={(kind, pinId, value) => runGpioCommand({ kind, pinId, requestedValue: value })} onDraft={updatePinDraft} onSave={savePinMetadata} onDevicePatch={saveDevicePatch} onSafeValue={saveServerSafeValue} onApplySafeState={applyServerSafeState} notify={flashNotice} />}

          {screen === "pins" && activeDevice && <section className="content-screen"><div className="page-heading"><div><p>DEVICE / {activeDevice.name.toUpperCase()}</p><h1>Pin Workbench</h1><span>Digital modes and output states remain requested until the device confirms them.</span></div><span className={`state-badge ${activeDevice.connectionState.toLowerCase()}`}><StatusLed tone={stateTone(activeDevice.connectionState)} />{activeDevice.connectionState}</span></div><div className="pin-layout"><article className="instrument-card board-panel"><div className="board-toolbar"><span><Cpu /> {activeDevice.boardName.toUpperCase()}</span><em>{activeDevice.simulated ? "SIMULATED DEVICE" : "PHYSICAL DEVICE"}</em></div><div className="uno-board"><div className="uno-usb"><span>USB-C</span></div><div className="uno-mark"><strong>UNO</strong><span>R4 WiFi</span></div><div className="board-chip"><span>RENESAS</span><strong>RA4M1</strong></div><div className="wifi-module"><Wifi /><span>ESP32-S3</span></div><div className="pin-bank digital-bank">{pins.filter((pin) => pin.pinId.startsWith("D")).map((pin) => <button key={pin.pinId} className={`${selectedPin === pin.pinId ? "selected" : ""} ${pin.confirmedValue ? "high" : ""}`} onClick={() => setSelectedPin(pin.pinId)}><i />{pin.pinId}</button>)}</div><div className="pin-bank analog-bank">{pins.filter((pin) => pin.pinId.startsWith("A")).map((pin) => <button key={pin.pinId} className={selectedPin === pin.pinId ? "selected" : ""} onClick={() => setSelectedPin(pin.pinId)}><i />{pin.pinId}</button>)}</div><span className="board-led power">ON</span><span className="board-led link">L</span></div><div className="legend"><span><i className="green" /> HIGH / ACTIVE</span><span><i className="amber" /> SELECTED</span><span><i /> LOW / IDLE</span></div></article><aside className="instrument-card pin-inspector"><div className="inspector-title"><div><strong>{selected.pinId}</strong><span>{selected.label || "Unlabeled pin"}</span></div><em>{selected.capability}</em></div><label className="field-label">PIN MODE<Select value={selected.mode} onValueChange={(value) => void changeMode(selected.pinId, value as PinMode)}><SelectTrigger className="wide"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INPUT">Digital Input</SelectItem><SelectItem value="INPUT_PULLUP">Input Pull-up</SelectItem><SelectItem value="OUTPUT">Digital Output</SelectItem>{selected.capability.includes("PWM") && <SelectItem value="PWM">PWM Output</SelectItem>}{selected.capability.includes("ANALOG") && <SelectItem value="ANALOG">Analog Input</SelectItem>}</SelectContent></Select></label><div className="large-state"><small>{pendingPin?.pinId === selected.pinId ? "REQUESTED STATE" : online ? "CONFIRMED STATE" : "LAST CONFIRMED"}</small><strong className={pendingPin?.pinId === selected.pinId ? "amber-text" : selected.confirmedValue ? "green-text" : ""}>{pendingPin?.pinId === selected.pinId ? (pendingPin.value ? "HIGH" : "LOW") : formatPinState(selected)}</strong>{advanced && <span>Configuration persisted · v{activeDevice.configurationVersion}</span>}</div>{selected.mode === "OUTPUT" && <div className="output-command"><Button variant={!selected.confirmedValue ? "default" : "outline"} onClick={() => void commandPin(selected.pinId, 0)} disabled={!online || maintenance || Boolean(pendingPin)}>SET LOW</Button><Button variant={selected.confirmedValue ? "default" : "outline"} onClick={() => void commandPin(selected.pinId, 1)} disabled={!online || maintenance || Boolean(pendingPin)}>SET HIGH</Button></div>}{selected.mode === "ANALOG" && <div className="scaling-block"><span>ENGINEERING SCALE</span><div><small>{selected.scaleInputLow ?? "—"} V</small><i /><small>{selected.scaleOutputLow ?? "—"} {selected.engineeringUnit ?? ""}</small></div><div><small>{selected.scaleInputHigh ?? "—"} V</small><i /><small>{selected.scaleOutputHigh ?? "—"} {selected.engineeringUnit ?? ""}</small></div></div>}<div className="electrical-note"><AlertTriangle /><span><strong>ELECTRICAL NOTE</strong>{selected.mode === "OUTPUT" ? "This pin is actively driven. Change it to input before connecting another driven signal." : "Capabilities and limits come from the validated board profile."}</span></div></aside></div><article className="instrument-card pin-table-card"><div className="table-tools"><label><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find pin or label" /></label><span>{visiblePins.length} / {pins.length} PROFILE PINS</span></div><Table><TableHeader><TableRow><TableHead>PIN</TableHead><TableHead>LABEL</TableHead><TableHead>MODE</TableHead><TableHead>CAPABILITY</TableHead><TableHead>STATE</TableHead><TableHead>SOURCE</TableHead></TableRow></TableHeader><TableBody>{visiblePins.map((pin) => <TableRow key={pin.pinId} onClick={() => setSelectedPin(pin.pinId)} className="pin-table-row"><TableCell><strong>{pin.pinId}</strong></TableCell><TableCell>{pin.label || "—"}</TableCell><TableCell>{pin.mode.replace("_", " ")}</TableCell><TableCell>{pin.capability}</TableCell><TableCell className={pin.confirmedValue ? "text-green" : ""}>{formatPinState(pin)}</TableCell><TableCell>{activeDevice.simulated ? "SIMULATOR" : "DEVICE"}</TableCell></TableRow>)}</TableBody></Table></article></section>}

          {screen === "monitor" && activeDevice && <TelemetryWorkbench key={activeDevice.id} device={activeDevice} pins={pins} liveLink={liveLink} onPins={setPins} notify={flashNotice} />}

          {screen === "automation" && <AutomationWorkbench devices={devices} advanced={advanced} notify={flashNotice} onRegistryRefresh={() => refreshTransportRegistry(activeDeviceId ?? undefined)} onDirtyChange={setAutomationDirty} />}
          {screen === "pins" && activeDevice && <GpioCommandPanels pin={selected} commands={commands} pendingPin={pendingPin} online={online} maintenance={maintenance} onDraft={updatePinDraft} onSave={savePinMetadata} onModeChange={changeMode} onAnalogOutput={(kind, pinId, value) => runGpioCommand({ kind, pinId, requestedValue: value })} />}
        </main>
        <footer className="statusbar"><span><StatusLed tone={registryStatus === "ready" ? "green" : registryStatus === "loading" ? "amber" : "red"} /> REGISTRY {registryStatus.toUpperCase()}</span><span><StatusLed tone={activeDevice ? stateTone(activeDevice.connectionState) : "gray"} /> DEVICE {activeDevice?.connectionState ?? "NONE"}</span><span><StatusLed tone={liveLink === "LIVE" ? "green" : liveLink === "STOPPED" ? "red" : "amber"} /> LIVE LINK {liveLink}</span><span>PROTOCOL 1</span><span>SCHEMA {DATABASE_SCHEMA_VERSION}</span><span className="statusbar-right">SWITCHBOARD COMMUNITY v{APP_VERSION}</span></footer>
      </SidebarInset>
    </SidebarProvider>
  </div>;
}
