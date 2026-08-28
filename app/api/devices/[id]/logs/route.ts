import { databaseError, getDatabase } from "@/db";
import { searchAgentLogs } from "@/lib/agent-server";
import { getDevice } from "@/lib/registry-server";

type Context = { params: Promise<{ id: string }> };

function csvCell(value: unknown) {
  const original = String(value ?? "");
  const text = /^[=+\-@]/.test(original) ? `'${original}` : original;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!await getDevice(getDatabase(), id)) return Response.json({ error: "Device not found" }, { status: 404 });
    const url = new URL(request.url);
    const level = url.searchParams.get("level");
    const query = url.searchParams.get("q");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (level && !["INFO", "WARN", "ERROR"].includes(level.toUpperCase())) return Response.json({ error: "Invalid agent log level" }, { status: 400 });
    const logs = await searchAgentLogs(getDatabase(), id, { level, query, limit });
    if (url.searchParams.get("format") === "csv") {
      const rows = [
        ["recorded_at", "level", "code", "message", "device_uptime_ms", "session_id"],
        ...logs.slice().reverse().map((log) => [new Date(log.recordedAt).toISOString(), log.level, log.code, log.message, log.deviceUptimeMs ?? "", log.sessionId ?? ""]),
      ];
      return new Response(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="switchboard-${id.toLowerCase()}-agent-logs.csv"`, "cache-control": "private, no-store" },
      });
    }
    return Response.json({ logs, limit: Math.max(1, Math.min(200, Math.round(Number.isFinite(limit) ? limit : 100))) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return Response.json({ error: databaseError(error) }, { status: 500 }); }
}
