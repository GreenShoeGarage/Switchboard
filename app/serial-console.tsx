"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Eraser, PlugZap, Send, ShieldCheck, Terminal, Unplug, Usb } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestUnoR4Port, supportsWebSerial, UnoR4SerialConsole } from "@/lib/flasher/web-serial";

type ConsoleLine = { id: number; direction: "RX" | "TX" | "SYSTEM"; text: string; at: number };
type Props = { deviceName: string; notify(message: string): void };

export function safeConsoleCommand(value: string) {
  if (!value.trim() || value.length > 512) throw new Error("Serial command must be 1–512 characters");
  if (/(?:swenr_|swdev_|password|credential|token|wifiPassword)/i.test(value)) throw new Error("Secrets are blocked in the debug console; use guided provisioning");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Enter a JSON command"); }
  const action = parsed && typeof parsed === "object" ? (parsed as { action?: unknown }).action : null;
  if (action !== "status" && action !== "identify") throw new Error("The debug console accepts only status and identify; provisioning and erase use their guided workflows");
  return JSON.stringify(parsed);
}

export function SerialConsole({ deviceName, notify }: Props) {
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('{"action":"status"}');
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const sequence = useRef(0);
  const session = useRef<UnoR4SerialConsole | null>(null);

  function append(direction: ConsoleLine["direction"], text: string) {
    const line = { id: ++sequence.current, direction, text, at: Date.now() };
    setLines((current) => [...current.slice(-299), line]);
  }

  useEffect(() => { window.queueMicrotask(() => setAvailable(supportsWebSerial())); }, []);
  useEffect(() => () => { void session.current?.disconnect(); }, []);

  async function connect() {
    setBusy(true);
    try {
      const next = new UnoR4SerialConsole(await requestUnoR4Port());
      await next.connect((line) => append("RX", line), (message) => {
        append("SYSTEM", message); setConnected(false); session.current = null;
      });
      session.current = next; setConnected(true);
      append("SYSTEM", `${next.identity().displayName} connected at 115200 baud`);
      notify("Browser-local serial console connected");
    } catch (error) { notify(error instanceof Error ? error.message : "Serial console could not connect"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    await session.current?.disconnect(); session.current = null; setConnected(false); setBusy(false);
    append("SYSTEM", "Operator disconnected the serial console");
  }

  async function send(value = draft) {
    try {
      const command = safeConsoleCommand(value);
      if (!session.current) throw new Error("Connect the serial console first");
      await session.current.sendLine(command); append("TX", command);
    } catch (error) { notify(error instanceof Error ? error.message : "Serial command was rejected"); }
  }

  function exportLog() {
    const text = lines.map((line) => `${new Date(line.at).toISOString()} ${line.direction.padEnd(6)} ${line.text}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `switchboard-${deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-serial.txt`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <article className="serial-console-panel">
    <div className="serial-console-head"><div><p>BROWSER-LOCAL USB</p><h2><Terminal /> Serial console</h2></div><Badge variant="outline" className={connected ? "manifest-good" : "manifest-pending"}>{connected ? "CONNECTED · 115200" : available ? "READY" : "DESKTOP CHROMIUM REQUIRED"}</Badge></div>
    <div className="serial-privacy"><ShieldCheck /><span><strong>LOCAL DATA PATH</strong> Console bytes stay between this browser and the selected USB port. Credential-shaped output is redacted before display.</span></div>
    <div className="serial-console-output" role="log" aria-live="polite" aria-label="Serial console output">
      {lines.map((line) => <div key={line.id} className={`serial-line ${line.direction.toLowerCase()}`}><time>{new Date(line.at).toLocaleTimeString()}</time><b>{line.direction}</b><code>{line.text}</code></div>)}
      {lines.length === 0 && <div className="serial-empty"><Usb /> Select the UNO R4 WiFi runtime port to inspect safe debug output.</div>}
    </div>
    <form className="serial-command-row" onSubmit={(event) => { event.preventDefault(); void send(); }}><Input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={512} disabled={!connected} aria-label="Safe serial JSON command" /><Button type="submit" disabled={!connected}><Send /> SEND</Button></form>
    <div className="serial-console-actions"><Button onClick={() => void connect()} disabled={!available || connected || busy}><PlugZap /> SELECT + CONNECT</Button><Button variant="outline" onClick={() => void send('{"action":"identify"}')} disabled={!connected}><Usb /> IDENTIFY</Button><Button variant="outline" onClick={() => void send('{"action":"status"}')} disabled={!connected}><Terminal /> STATUS</Button><Button variant="ghost" onClick={() => void disconnect()} disabled={!connected || busy}><Unplug /> DISCONNECT</Button><Button variant="ghost" onClick={() => setLines([])} disabled={!lines.length}><Eraser /> CLEAR VIEW</Button><Button variant="ghost" onClick={exportLog} disabled={!lines.length}><Download /> EXPORT</Button></div>
  </article>;
}
