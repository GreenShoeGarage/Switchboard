"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Archive, Bot, Clock3, History,
  LockKeyhole, Play, Plus, RefreshCw, Save, ShieldCheck, Sparkles, Zap,
} from "lucide-react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AutomationActionRecord, AutomationComparator, AutomationExecutionRecord,
  AutomationRuleMode, AutomationRuleRecord, AutomationTriggerKind, DevicePin, DeviceRecord,
} from "@/lib/device-model";

type Props = {
  devices: DeviceRecord[];
  advanced: boolean;
  notify(message: string, duration?: number): void;
  onRegistryRefresh(): Promise<void>;
  onDirtyChange?(dirty: boolean): void;
};

type Draft = {
  id: string | null;
  revision: number | null;
  name: string;
  description: string;
  actionScope: "SIMULATOR_ONLY" | "PHYSICAL_CONTROL";
  triggerKind: AutomationTriggerKind;
  sourceDeviceId: string;
  sourcePinId: string;
  comparator: AutomationComparator;
  thresholdValue: number;
  hysteresis: number;
  holdSeconds: number;
  maxSampleAgeSeconds: number;
  intervalSeconds: number;
  scheduleTime: string;
  scheduleDaysMask: number;
  targetDeviceId: string;
  targetPinId: string;
  commandKind: AutomationActionRecord["commandKind"];
  requestedValue: number;
  cooldownSeconds: number;
  rateLimitCount: number;
  rateWindowMinutes: number;
  maxChainDepth: number;
};

class RequestError extends Error {
  issues: Array<{ path: string; message: string }>;
  constructor(message: string, issues: Array<{ path: string; message: string }> = []) { super(message); this.issues = issues; }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({})) as { error?: string; issues?: Array<{ path: string; message: string }> };
  if (!response.ok) throw new RequestError(payload.error ?? `Request failed (${response.status})`, payload.issues ?? []);
  return payload as T;
}

function defaultDraft(devices: DeviceRecord[]): Draft {
  const source = devices[0]?.id ?? "";
  const targetDevice = devices.find((device) => device.simulated) ?? devices[0] ?? null;
  const target = targetDevice?.id ?? "";
  return {
    id: null, revision: null, name: "New automation rule", description: "",
    actionScope: targetDevice && !targetDevice.simulated ? "PHYSICAL_CONTROL" : "SIMULATOR_ONLY", triggerKind: "THRESHOLD", sourceDeviceId: source,
    sourcePinId: "A1", comparator: "GT", thresholdValue: 35, hysteresis: 1,
    holdSeconds: 10, maxSampleAgeSeconds: 30, intervalSeconds: 60,
    scheduleTime: "12:00", scheduleDaysMask: 127, targetDeviceId: target,
    targetPinId: "D7", commandKind: "WRITE", requestedValue: 1,
    cooldownSeconds: 60, rateLimitCount: 10, rateWindowMinutes: 60, maxChainDepth: 2,
  };
}

function minuteToTime(minute: number | null) {
  const safe = minute ?? 720;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function draftFromRule(rule: AutomationRuleRecord): Draft {
  const action = rule.actions[0];
  return {
    id: rule.id, revision: rule.revision, name: rule.name, description: rule.description,
    actionScope: rule.actionScope, triggerKind: rule.trigger.kind,
    sourceDeviceId: rule.trigger.sourceDeviceId ?? "", sourcePinId: rule.trigger.sourcePinId ?? "A1",
    comparator: rule.trigger.comparator ?? "GT", thresholdValue: rule.trigger.thresholdValue ?? 35,
    hysteresis: rule.trigger.hysteresis, holdSeconds: rule.trigger.holdForMs / 1000,
    maxSampleAgeSeconds: rule.trigger.maxSampleAgeMs / 1000,
    intervalSeconds: (rule.trigger.intervalMs ?? 60_000) / 1000,
    scheduleTime: minuteToTime(rule.trigger.scheduleMinuteUtc), scheduleDaysMask: rule.trigger.scheduleDaysMask ?? 127,
    targetDeviceId: action?.targetDeviceId ?? "", targetPinId: action?.targetPinId ?? "D7",
    commandKind: action?.commandKind ?? "WRITE", requestedValue: action?.requestedValue ?? 1,
    cooldownSeconds: rule.cooldownMs / 1000, rateLimitCount: rule.rateLimitCount,
    rateWindowMinutes: rule.rateLimitWindowMs / 60_000, maxChainDepth: rule.maxChainDepth,
  };
}

function payloadFromDraft(draft: Draft) {
  const [hours, minutes] = draft.scheduleTime.split(":").map(Number);
  return {
    name: draft.name, description: draft.description, actionScope: draft.actionScope,
    trigger: draft.triggerKind === "THRESHOLD" ? {
      kind: "THRESHOLD", sourceDeviceId: draft.sourceDeviceId, sourcePinId: draft.sourcePinId,
      comparator: draft.comparator, thresholdValue: Number(draft.thresholdValue), hysteresis: Number(draft.hysteresis),
      holdForMs: Math.round(Number(draft.holdSeconds) * 1000), maxSampleAgeMs: Math.round(Number(draft.maxSampleAgeSeconds) * 1000),
    } : draft.triggerKind === "INTERVAL" ? {
      kind: "INTERVAL", intervalMs: Math.round(Number(draft.intervalSeconds) * 1000),
    } : {
      kind: "SCHEDULE", scheduleMinuteUtc: hours * 60 + minutes,
      scheduleDaysMask: Number(draft.scheduleDaysMask), scheduleTimezone: "UTC",
    },
    actions: [{
      targetDeviceId: draft.targetDeviceId, targetPinId: draft.targetPinId,
      commandKind: draft.commandKind, requestedValue: Number(draft.requestedValue),
    }],
    cooldownMs: Math.round(Number(draft.cooldownSeconds) * 1000), rateLimitCount: Number(draft.rateLimitCount),
    rateLimitWindowMs: Math.round(Number(draft.rateWindowMinutes) * 60_000), maxChainDepth: Number(draft.maxChainDepth),
  };
}

function commandKindFor(pin?: DevicePin): AutomationActionRecord["commandKind"] {
  return pin?.mode === "PWM" ? "WRITE_PWM" : pin?.mode === "DAC" ? "WRITE_DAC" : "WRITE";
}

function modeTone(mode: AutomationRuleMode) {
  return mode === "LIVE" ? "live" : mode === "DRY_RUN" ? "dry" : "disabled";
}

function executionTone(status: string) {
  if (["ACKNOWLEDGED", "DRY_RUN"].includes(status)) return "good";
  if (["ARMED", "QUEUED", "RUNNING", "COOLDOWN", "RATE_LIMITED"].includes(status)) return "pending";
  if (["NO_MATCH", "RESET"].includes(status)) return "neutral";
  return "bad";
}

function formatWhen(rule: AutomationRuleRecord) {
  if (rule.trigger.kind === "INTERVAL") return `Every ${Math.round((rule.trigger.intervalMs ?? 0) / 1000)} seconds`;
  if (rule.trigger.kind === "SCHEDULE") return `${minuteToTime(rule.trigger.scheduleMinuteUtc)} UTC · mask ${rule.trigger.scheduleDaysMask}`;
  return `${rule.trigger.sourcePinId} ${rule.trigger.comparator} ${rule.trigger.thresholdValue}${rule.trigger.sourceUnit ? ` ${rule.trigger.sourceUnit}` : ""}`;
}

export function AutomationWorkbench({ devices, advanced, notify, onRegistryRefresh, onDirtyChange }: Props) {
  const [rules, setRules] = useState<AutomationRuleRecord[]>([]);
  const [executions, setExecutions] = useState<AutomationExecutionRecord[]>([]);
  const [pinsByDevice, setPinsByDevice] = useState<Record<string, DevicePin[]>>({});
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modeFilter, setModeFilter] = useState("ALL");
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [lastEvaluation, setLastEvaluation] = useState<AutomationExecutionRecord | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const pinInventorySignature = useMemo(() => JSON.stringify(devices
    .map((device) => [device.id, device.configurationVersion] as const)
    .sort(([left], [right]) => left.localeCompare(right))), [devices]);

  const load = useCallback(async (preferredRuleId?: string | null) => {
    setLoading(true);
    try {
      const payload = await requestJson<{ rules: AutomationRuleRecord[]; executions: AutomationExecutionRecord[] }>("/api/automations");
      setRules(payload.rules); setExecutions(payload.executions);
      const preferred = preferredRuleId ?? selectedRuleId;
      const next = payload.rules.find((rule) => rule.id === preferred) ?? payload.rules[0] ?? null;
      if (next) {
        setSelectedRuleId(next.id); setDraft(draftFromRule(next));
        setLastEvaluation((current) => current?.ruleId === next.id && current.ruleRevision === next.revision ? current : null);
      }
      else if (!draft?.id) setDraft((current) => current ?? defaultDraft(devices));
      setDirty(false); setIssues([]);
    } catch (error) { notify(error instanceof Error ? error.message : "Automation registry could not be loaded", 3600); }
    finally { setLoading(false); }
  }, [devices, draft, notify, selectedRuleId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    const inventory = JSON.parse(pinInventorySignature) as Array<[string, number]>;
    void Promise.all(inventory.map(async ([deviceId]) => {
      try {
        const payload = await requestJson<{ pins: DevicePin[] }>(`/api/devices/${encodeURIComponent(deviceId)}/pins`);
        return [deviceId, payload.pins] as const;
      } catch { return [deviceId, []] as const; }
    })).then((entries) => { if (!cancelled) setPinsByDevice(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [pinInventorySignature]);

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? null;
  const sourcePins = pinsByDevice[draft?.sourceDeviceId ?? ""] ?? [];
  const targetPins = (pinsByDevice[draft?.targetDeviceId ?? ""] ?? []).filter((pin) => ["OUTPUT", "PWM", "DAC"].includes(pin.mode));
  const targetDevice = devices.find((device) => device.id === draft?.targetDeviceId) ?? null;
  const filteredRules = useMemo(() => rules.filter((rule) => {
    const match = `${rule.name} ${formatWhen(rule)} ${rule.actions[0]?.targetPinId ?? ""}`.toLowerCase().includes(search.toLowerCase());
    return match && (modeFilter === "ALL" || rule.mode === modeFilter);
  }), [modeFilter, rules, search]);
  const metrics = {
    live: rules.filter((rule) => rule.mode === "LIVE").length,
    dry: rules.filter((rule) => rule.mode === "DRY_RUN").length,
    disabled: rules.filter((rule) => rule.mode === "DISABLED").length,
    blocked: rules.filter((rule) => rule.suspensionReasons.length > 0).length,
  };

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current); setDirty(true); setIssues([]);
  }

  function chooseRule(rule: AutomationRuleRecord) {
    if (dirty && !window.confirm("Discard the unsaved automation draft?")) return;
    setSelectedRuleId(rule.id); setDraft(draftFromRule(rule)); setDirty(false); setIssues([]); setLastEvaluation(null);
  }

  function newRule() {
    if (dirty && !window.confirm("Discard the unsaved automation draft?")) return;
    setSelectedRuleId(null); setDraft(defaultDraft(devices)); setDirty(true); setIssues([]); setLastEvaluation(null);
    window.setTimeout(() => nameRef.current?.focus(), 0);
  }

  async function saveRule() {
    if (!draft || selectedRule?.mode === "LIVE") return;
    setBusy("save"); setIssues([]);
    try {
      const payload = draft.id
        ? await requestJson<{ rule: AutomationRuleRecord }>(`/api/automations/${encodeURIComponent(draft.id)}`, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: draft.revision, rule: payloadFromDraft(draft) }),
        })
        : await requestJson<{ rule: AutomationRuleRecord }>("/api/automations", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payloadFromDraft(draft)),
        });
      setLastEvaluation(null); notify(`${payload.rule.name} saved disabled`); await load(payload.rule.id);
    } catch (error) {
      if (error instanceof RequestError) setIssues(error.issues);
      notify(error instanceof Error ? error.message : "Rule was not saved", 3600);
    } finally { setBusy(null); }
  }

  async function changeMode(mode: AutomationRuleMode) {
    if (!selectedRule || dirty) return;
    setBusy("mode"); setIssues([]);
    try {
      const payload = await requestJson<{ rule: AutomationRuleRecord; deliveredCommands: number }>(`/api/automations/${encodeURIComponent(selectedRule.id)}/state`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, expectedRevision: selectedRule.revision }),
      });
      notify(payload.deliveredCommands > 0 ? `${payload.rule.name} changed state; ${payload.deliveredCommands} delivered command cannot be recalled` : `${payload.rule.name} → ${mode.replace("_", " ")}`, 4000);
      await load(selectedRule.id);
    } catch (error) {
      if (error instanceof RequestError) setIssues(error.issues);
      notify(error instanceof Error ? error.message : "Rule state was not changed", 4000);
    } finally { setBusy(null); }
  }

  async function waitForTerminalExecution(ruleId: string, executionId: string) {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      try {
        const payload = await requestJson<{ executions: AutomationExecutionRecord[] }>(
          `/api/automation-executions?ruleId=${encodeURIComponent(ruleId)}&limit=20`,
        );
        setExecutions((current) => {
          const otherRules = current.filter((execution) => execution.ruleId !== ruleId);
          return [...payload.executions, ...otherRules].sort((left, right) => right.requestedAt - left.requestedAt).slice(0, 40);
        });
        const current = payload.executions.find((execution) => execution.id === executionId);
        if (!current) continue;
        setLastEvaluation(current);
        if (current.status !== "QUEUED" && current.status !== "RUNNING") return current;
      } catch { return null; }
    }
    return null;
  }

  async function evaluate(mode: "DRY_RUN" | "MANUAL") {
    if (!selectedRule || dirty) return;
    setBusy("evaluate"); setIssues([]);
    try {
      const payload = await requestJson<{ execution: AutomationExecutionRecord | null }>(`/api/automations/${encodeURIComponent(selectedRule.id)}/evaluate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, expectedRevision: selectedRule.revision, confirmHardware: mode === "MANUAL" }),
      });
      setLastEvaluation(payload.execution);
      notify(payload.execution ? `${mode === "DRY_RUN" ? "Dry run" : "Live evaluation"}: ${payload.execution.status.replace("_", " ")}` : "No new execution was admitted");
      await load(selectedRule.id);
      if (payload.execution && (payload.execution.status === "QUEUED" || payload.execution.status === "RUNNING")) {
        const terminal = await waitForTerminalExecution(selectedRule.id, payload.execution.id);
        if (terminal) notify(`Live execution: ${terminal.status.replace("_", " ")}`, 4000);
      }
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (error) {
      if (error instanceof RequestError) setIssues(error.issues);
      notify(error instanceof Error ? error.message : "Evaluation failed", 4000);
    } finally { setBusy(null); }
  }

  async function archiveRule() {
    if (!selectedRule || dirty) return;
    setBusy("archive");
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(selectedRule.id)}?expectedRevision=${selectedRule.revision}`, { method: "DELETE" });
      if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? "Rule was not archived"); }
      notify(`${selectedRule.name} archived`); setSelectedRuleId(null); setDraft(null); setLastEvaluation(null); await load(null);
    } catch (error) { notify(error instanceof Error ? error.message : "Rule was not archived", 3600); }
    finally { setBusy(null); }
  }

  async function setDeviceAutomationArmed(armed: boolean) {
    if (!targetDevice || dirty) return;
    setBusy("arm-device");
    try {
      await requestJson(`/api/devices/${encodeURIComponent(targetDevice.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ automationArmed: armed }),
      });
      notify(`${targetDevice.name} automation permission ${armed ? "armed" : "disarmed"}`);
      await onRegistryRefresh(); await load(selectedRuleId);
    } catch (error) { notify(error instanceof Error ? error.message : "Device permission was not changed", 4000); }
    finally { setBusy(null); }
  }

  const latestResult = (lastEvaluation?.ruleId === selectedRuleId && lastEvaluation.ruleRevision === selectedRule?.revision ? lastEvaluation : null)
    ?? executions.find((execution) => execution.ruleId === selectedRuleId && execution.ruleRevision === selectedRule?.revision)
    ?? null;
  const staticValidity = issues.length > 0 ? "BLOCKED" : dirty || !selectedRule ? "UNVALIDATED" : "VALIDATED";

  return <section className="content-screen automation-workbench">
    <div className="page-heading"><div><p>RULE ENGINE / BATCH 8</p><h1>Automation</h1><span>Validated server-side rules turn fresh confirmed state into bounded, acknowledged output commands. Rules never contain executable code.</span></div><Button onClick={newRule}><Plus /> NEW RULE</Button></div>

    <section className="automation-metrics" aria-label="Automation summary">
      <article><Zap /><span><strong>{metrics.live}</strong><small>LIVE RULES</small></span></article>
      <article><Sparkles /><span><strong>{metrics.dry}</strong><small>DRY-RUN RULES</small></span></article>
      <article><LockKeyhole /><span><strong>{metrics.disabled}</strong><small>DISABLED</small></span></article>
      <article className={metrics.blocked ? "blocked" : ""}><AlertTriangle /><span><strong>{metrics.blocked}</strong><small>POLICY BLOCKS</small></span></article>
    </section>

    <div className="automation-clock-boundary"><Clock3 /><div><strong>ACTIVITY-DRIVEN SERVER TIME</strong><span>Thresholds evaluate on fresh accepted device state. Interval and UTC schedule checks run while devices heartbeat, snapshot, or poll; no unattended cron service is claimed, and missed occurrences are not replayed.</span></div></div>

    <Tabs defaultValue="rules" className="automation-tabs">
      <TabsList><TabsTrigger value="rules"><Bot /> RULES</TabsTrigger><TabsTrigger value="history"><History /> HISTORY</TabsTrigger></TabsList>
      <TabsContent value="rules">
        <div className="automation-layout">
          <aside className="instrument-card automation-rule-list">
            <div className="automation-list-tools"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search rules" aria-label="Search automation rules" /><Select value={modeFilter} onValueChange={setModeFilter}><SelectTrigger aria-label="Filter rules by mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All modes</SelectItem><SelectItem value="LIVE">Live</SelectItem><SelectItem value="DRY_RUN">Dry run</SelectItem><SelectItem value="DISABLED">Disabled</SelectItem></SelectContent></Select></div>
            <div className="automation-rule-scroll">{loading && <div className="table-empty">Loading rules…</div>}{!loading && filteredRules.length === 0 && <div className="automation-empty"><Bot /><strong>No matching rules</strong><span>Create a disabled rule, save it, then prove it with a dry run.</span></div>}{filteredRules.map((rule) => <button key={rule.id} className={`automation-rule-choice ${selectedRuleId === rule.id ? "selected" : ""}`} aria-pressed={selectedRuleId === rule.id} onClick={() => chooseRule(rule)}><span className={`automation-mode-dot ${modeTone(rule.mode)}`} /><span><strong>{rule.name}</strong><small>{formatWhen(rule)}</small><em>{rule.actions[0]?.targetPinId ?? "missing target"} · revision {rule.revision}</em></span><Badge variant="outline">{rule.mode.replace("_", " ")}</Badge>{rule.suspensionReasons.length > 0 && <AlertTriangle aria-label={`${rule.suspensionReasons.length} policy blocks`} />}</button>)}</div>
          </aside>

          <article className="instrument-card automation-editor">
            {!draft ? <div className="automation-empty large"><Bot /><strong>Select or create a rule</strong><span>The editor exposes the exact WHEN → FOR → THEN structure and its safety limits.</span><Button onClick={newRule}><Plus /> NEW RULE</Button></div> : <>
              <header className="automation-editor-head"><div><p>STRUCTURED RULE</p><h2>{draft.id ? draft.name : "Unsaved rule"}</h2></div><span className={`rule-mode ${modeTone(selectedRule?.mode ?? "DISABLED")}`}>{selectedRule?.mode.replace("_", " ") ?? "NEW · DISABLED"}</span></header>
              {issues.length > 0 && <div className="automation-errors" role="alert"><AlertTriangle /><div><strong>RULE NEEDS ATTENTION</strong>{issues.map((issue, index) => <span key={`${issue.path}-${index}`}>{issue.path || "rule"}: {issue.message}</span>)}</div></div>}
              <div className="automation-editor-fields">
                <label className="field-label">RULE NAME<Input ref={nameRef} value={draft.name} onChange={(event) => update("name", event.target.value)} maxLength={80} disabled={selectedRule?.mode === "LIVE"} /></label>
                <label className="field-label">DESCRIPTION<Input value={draft.description} onChange={(event) => update("description", event.target.value)} maxLength={500} placeholder="Purpose and operating boundary" disabled={selectedRule?.mode === "LIVE"} /></label>
              </div>

              <section className="automation-logic-section when"><div className="logic-key"><strong>WHEN</strong><span>one structured trigger</span></div><div className="logic-fields">
                <label className="field-label">TRIGGER<Select value={draft.triggerKind} onValueChange={(value) => update("triggerKind", value as AutomationTriggerKind)} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="THRESHOLD">Pin threshold</SelectItem><SelectItem value="INTERVAL">UTC interval</SelectItem><SelectItem value="SCHEDULE">UTC schedule</SelectItem></SelectContent></Select></label>
                {draft.triggerKind === "THRESHOLD" && <><label className="field-label">SOURCE DEVICE<Select value={draft.sourceDeviceId} onValueChange={(value) => { update("sourceDeviceId", value); update("sourcePinId", pinsByDevice[value]?.[0]?.pinId ?? ""); }} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue placeholder="Select device" /></SelectTrigger><SelectContent>{devices.map((device) => <SelectItem key={device.id} value={device.id}>{device.name}</SelectItem>)}</SelectContent></Select></label><label className="field-label">SOURCE PIN<Select value={draft.sourcePinId} onValueChange={(value) => update("sourcePinId", value)} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue placeholder={sourcePins.length ? "Select source pin" : "No source pins"} /></SelectTrigger><SelectContent>{sourcePins.map((pin) => <SelectItem key={pin.pinId} value={pin.pinId}>{pin.pinId} · {pin.label || pin.mode}</SelectItem>)}</SelectContent></Select></label><label className="field-label">COMPARATOR<Select value={draft.comparator} onValueChange={(value) => update("comparator", value as AutomationComparator)} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="GT">Greater than</SelectItem><SelectItem value="GTE">At or above</SelectItem><SelectItem value="LT">Less than</SelectItem><SelectItem value="LTE">At or below</SelectItem><SelectItem value="EQ">Equal</SelectItem><SelectItem value="NE">Not equal</SelectItem></SelectContent></Select></label><label className="field-label">THRESHOLD<Input type="number" step="any" value={draft.thresholdValue} onChange={(event) => update("thresholdValue", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /><small>{sourcePins.find((pin) => pin.pinId === draft.sourcePinId)?.engineeringUnit ?? "confirmed value"}</small></label>{advanced && <label className="field-label">HYSTERESIS<Input type="number" min="0" step="any" value={draft.hysteresis} onChange={(event) => update("hysteresis", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label>}</>}
                {draft.triggerKind === "INTERVAL" && <label className="field-label">INTERVAL · SECONDS<Input type="number" min="10" max="604800" value={draft.intervalSeconds} onChange={(event) => update("intervalSeconds", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /><small>Best effort; missed intervals are skipped.</small></label>}
                {draft.triggerKind === "SCHEDULE" && <><label className="field-label">UTC TIME<Input type="time" value={draft.scheduleTime} onChange={(event) => update("scheduleTime", event.target.value)} disabled={selectedRule?.mode === "LIVE"} /></label><label className="field-label">UTC DAYS<Select value={String(draft.scheduleDaysMask)} onValueChange={(value) => update("scheduleDaysMask", Number(value))} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="127">Every day</SelectItem><SelectItem value="62">Weekdays</SelectItem><SelectItem value="65">Weekends</SelectItem></SelectContent></Select></label></>}
              </div></section>

              <section className="automation-logic-section for"><div className="logic-key"><strong>FOR</strong><span>fresh-sample persistence</span></div><div className="logic-fields">{draft.triggerKind === "THRESHOLD" ? <><label className="field-label">HOLD · SECONDS<Input type="number" min="0" max="86400" value={draft.holdSeconds} onChange={(event) => update("holdSeconds", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label>{advanced && <label className="field-label">MAX SAMPLE AGE · SECONDS<Input type="number" min="1" max="300" value={draft.maxSampleAgeSeconds} onChange={(event) => update("maxSampleAgeSeconds", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label>}<p>False, stale, missing, disconnected, or reconfigured input resets the hold window.</p></> : <p>Time triggers claim one persisted UTC occurrence. They never replay a burst after downtime.</p>}</div></section>

              <section className="automation-logic-section then"><div className="logic-key"><strong>THEN</strong><span>one absolute output</span></div><div className="logic-fields"><label className="field-label">TARGET DEVICE<Select value={draft.targetDeviceId} onValueChange={(value) => { const device = devices.find((candidate) => candidate.id === value); const first = (pinsByDevice[value] ?? []).find((pin) => ["OUTPUT", "PWM", "DAC"].includes(pin.mode)); update("targetDeviceId", value); update("actionScope", device && !device.simulated ? "PHYSICAL_CONTROL" : "SIMULATOR_ONLY"); update("targetPinId", first?.pinId ?? ""); update("commandKind", commandKindFor(first)); update("requestedValue", 0); }} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue placeholder="Select device" /></SelectTrigger><SelectContent>{devices.map((device) => <SelectItem key={device.id} value={device.id}>{device.name} · {device.simulated ? "simulator" : "physical"}</SelectItem>)}</SelectContent></Select></label><label className="field-label">OUTPUT PIN<Select value={draft.targetPinId} onValueChange={(value) => { const pin = targetPins.find((item) => item.pinId === value); update("targetPinId", value); update("commandKind", commandKindFor(pin)); update("requestedValue", 0); }} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue placeholder={targetPins.length ? "Select output pin" : "No output pins"} /></SelectTrigger><SelectContent>{targetPins.map((pin) => <SelectItem key={pin.pinId} value={pin.pinId}>{pin.pinId} · {pin.label || pin.mode} · {pin.mode}</SelectItem>)}</SelectContent></Select></label><label className="field-label">ABSOLUTE VALUE<Input type="number" min="0" max={draft.commandKind === "WRITE" ? 1 : 4095} step="1" value={draft.requestedValue} onChange={(event) => update("requestedValue", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /><small>{draft.commandKind === "WRITE" ? "0 = LOW · 1 = HIGH" : "12-bit integer · 0–4095"}</small></label>{(advanced || targetDevice?.simulated === false) && <label className="field-label">ACTION SCOPE<Select value={draft.actionScope} onValueChange={(value) => update("actionScope", value as Draft["actionScope"])} disabled={selectedRule?.mode === "LIVE"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SIMULATOR_ONLY">Simulator only</SelectItem><SelectItem value="PHYSICAL_CONTROL">Physical control · HIL gated</SelectItem></SelectContent></Select></label>}</div></section>

              <section className="automation-logic-section limits"><div className="logic-key"><strong>LIMITS</strong><span>persistent protection</span></div><div className="logic-fields"><label className="field-label">COOLDOWN · SECONDS<Input type="number" min="5" max="86400" value={draft.cooldownSeconds} onChange={(event) => update("cooldownSeconds", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /><small>Live minimum: 5 seconds</small></label><label className="field-label">MAX EXECUTIONS<Input type="number" min="1" max="60" value={draft.rateLimitCount} onChange={(event) => update("rateLimitCount", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label><label className="field-label">RATE WINDOW · MINUTES<Input type="number" min="1" max="1440" value={draft.rateWindowMinutes} onChange={(event) => update("rateWindowMinutes", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label>{advanced && <label className="field-label">MAX CHAIN DEPTH<Input type="number" min="0" max="4" value={draft.maxChainDepth} onChange={(event) => update("maxChainDepth", Number(event.target.value))} disabled={selectedRule?.mode === "LIVE"} /></label>}</div></section>

              <section className="automation-safety-summary"><div className={staticValidity === "VALIDATED" ? "ready" : staticValidity === "BLOCKED" ? "blocked" : ""}><ShieldCheck /><span><strong>STATIC {staticValidity}</strong><small>Pin modes, units, values, revisions, and obvious dependency loops are checked before enabling.</small></span></div><div className={targetDevice?.automationArmed ? "ready" : "blocked"}><LockKeyhole /><span><strong>DEVICE PERMISSION</strong><small>{targetDevice ? `${targetDevice.name}: ${targetDevice.automationArmed ? "ARMED" : "DISARMED"} · applies to every rule targeting this device` : "Select a target device"}</small></span>{targetDevice && <Switch checked={targetDevice.automationArmed} onCheckedChange={(checked) => void setDeviceAutomationArmed(checked)} disabled={dirty || busy !== null} aria-label={`${targetDevice.automationArmed ? "Disarm" : "Arm"} ${targetDevice.name} for automation`} />}</div><div><Activity /><span><strong>RUNTIME REVALIDATION</strong><small>Online state, current-session snapshot, locks, device permission, configuration revision, and pending pin are rechecked at queue and claim.</small></span></div><div className="blocked"><AlertTriangle /><span><strong>PHYSICAL CONFIDENCE BOUNDARY</strong><small>Physical automation stays gated until its Hardware-in-the-Loop record passes. This is not a safety-rated or real-time controller.</small></span></div></section>

              <footer className="automation-editor-actions"><div aria-live="polite">{dirty ? "Unsaved draft · saving creates a disabled revision" : selectedRule ? `Revision ${selectedRule.revision} · ${selectedRule.mode.replace("_", " ")}` : "New rule · disabled by default"}</div><Button variant="outline" onClick={() => void saveRule()} disabled={!dirty || busy !== null || selectedRule?.mode === "LIVE"}><Save /> {busy === "save" ? "SAVING…" : "SAVE DISABLED"}</Button>{selectedRule && <Button variant="outline" onClick={() => void evaluate("DRY_RUN")} disabled={dirty || busy !== null}><Sparkles /> DRY RUN</Button>}{selectedRule?.mode === "DISABLED" && <Button variant="outline" onClick={() => void changeMode("DRY_RUN")} disabled={dirty || busy !== null}><Bot /> ENABLE DRY RUN</Button>}{selectedRule?.mode !== "DISABLED" && <Button variant="outline" onClick={() => void changeMode("DISABLED")} disabled={busy !== null}><LockKeyhole /> DISABLE</Button>}{selectedRule && selectedRule.mode !== "LIVE" && <AlertDialog><AlertDialogTrigger asChild><Button disabled={dirty || busy !== null || selectedRule.suspensionReasons.length > 0}><Play /> ENABLE LIVE</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Enable live automation?</AlertDialogTitle><AlertDialogDescription>This approves revision {selectedRule.revision}. A fresh matching trigger may queue a real output command. Device locks, explicit automation permission, configuration revision, cooldown, rate limit, and acknowledgment remain mandatory.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void changeMode("LIVE")}>ENABLE REVISION {selectedRule.revision}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}{advanced && selectedRule?.mode === "LIVE" && <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" disabled={busy !== null}><Zap /> EVALUATE LIVE NOW</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Evaluate the live rule now?</AlertDialogTitle><AlertDialogDescription>This does not force the action or bypass the condition. If the current trigger matches and every guard passes, a real output command may be queued.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void evaluate("MANUAL")}>CONFIRM LIVE EVALUATION</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</footer>

              {selectedRule?.suspensionReasons.length ? <div className="automation-block-reasons"><AlertTriangle /><div><strong>LIVE EXECUTION BLOCKED</strong>{selectedRule.suspensionReasons.map((reason) => <span key={reason}>{reason}</span>)}</div></div> : null}
              {selectedRule?.mode === "DISABLED" && <div className="automation-archive-row"><AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" disabled={dirty || busy !== null}><Archive /> ARCHIVE RULE</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {selectedRule.name}?</AlertDialogTitle><AlertDialogDescription>The rule disappears from the active list, but its execution and command evidence remains retained.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>CANCEL</AlertDialogCancel><AlertDialogAction onClick={() => void archiveRule()}>ARCHIVE RULE</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>}
            </>}
          </article>
        </div>

        {latestResult && <article ref={resultRef} tabIndex={-1} className={`instrument-card automation-evaluation ${executionTone(latestResult.status)}`}><div className="card-head"><div><p>{latestResult.executionMode === "DRY_RUN" ? "DRY RUN / LAST RESULT" : "LIVE EXECUTION / LAST RESULT"}</p><h2>{latestResult.status.replace("_", " ")}</h2></div><Badge variant="outline">{latestResult.executionMode}</Badge></div><div className="evaluation-evidence"><span><small>SOURCE</small><strong>{latestResult.sourceKind}</strong></span><span><small>VALUE</small><strong>{latestResult.triggerValue ?? "—"}</strong></span><span><small>RECORDED</small><strong>{latestResult.triggerRecordedAt ? new Date(latestResult.triggerRecordedAt).toLocaleString() : "—"}</strong></span><span><small>COMMANDS</small><strong>{latestResult.actions.filter((action) => action.gpioCommandId).length}</strong></span></div><p>{latestResult.reason}</p>{latestResult.executionMode === "DRY_RUN" && <div className="dry-run-seal"><Sparkles /><strong>SIMULATION ONLY — NO COMMANDS SENT</strong></div>}</article>}
      </TabsContent>

      <TabsContent value="history"><article className="instrument-card automation-history"><div className="card-head"><div><p>PERSISTENT EXECUTION LEDGER</p><h2>Execution history</h2></div><Button variant="outline" onClick={() => { if (!dirty) void load(selectedRuleId); }} disabled={loading || dirty || busy !== null}><RefreshCw /> REFRESH</Button></div><div className="automation-history-note"><ShieldCheck /> Trigger matches are not success. Hardware execution is successful only after every linked command is acknowledged.</div><Table><TableHeader><TableRow><TableHead>WHEN</TableHead><TableHead>RULE</TableHead><TableHead>SOURCE</TableHead><TableHead>RESULT</TableHead><TableHead>EVIDENCE</TableHead><TableHead>ACTION</TableHead></TableRow></TableHeader><TableBody>{executions.map((execution) => <TableRow key={execution.id}><TableCell>{new Date(execution.requestedAt).toLocaleString()}</TableCell><TableCell><strong>{execution.ruleName}</strong><small>r{execution.ruleRevision}</small></TableCell><TableCell>{execution.sourceKind}</TableCell><TableCell><span className={`execution-status ${executionTone(execution.status)}`}>{execution.status.replace("_", " ")}</span></TableCell><TableCell>{execution.triggerValue ?? "—"}<small>{execution.reason}</small></TableCell><TableCell>{execution.actions[0] ? `${execution.actions[0].targetDeviceId} / ${execution.actions[0].targetPinId} → ${execution.actions[0].requestedValue}` : "—"}<small>{execution.actions[0]?.status ?? "No command"}</small></TableCell></TableRow>)}{executions.length === 0 && <TableRow><TableCell colSpan={6}><div className="table-empty">No automation executions have been recorded.</div></TableCell></TableRow>}</TableBody></Table></article></TabsContent>
    </Tabs>
  </section>;
}
