import type { DatabaseBinding } from "@/db";
import type { AgentLogLevel, AgentLogRecord } from "@/lib/device-model";

type Row = Record<string, unknown>;
const LEVELS = new Set<AgentLogLevel>(["INFO", "WARN", "ERROR"]);

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function numberOrNull(value: unknown) { return typeof value === "number" ? value : null; }

export function redactAgentLogText(value: unknown, limit = 180) {
  return text(value)
    .replace(/(?:swenr_|swdev_)[A-Za-z0-9_-]+/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+\/-]+/gi, "$1 [REDACTED]")
    .replace(/("?(?:wifi[_-]?password|password|credential|token|api[_-]?key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/("?(?:wifi[_-]?password|password|credential|token|api[_-]?key)"?\s*[:=]\s*)'[^']*'/gi, "$1'[REDACTED]'")
    .replace(/\b(wifi[_-]?password|password|credential|token|api[_-]?key)\b"?\s*[:=]\s*[^,\s}]+/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, limit);
}

function mapLog(row: Row): AgentLogRecord {
  return {
    id: Number(row.id), deviceId: text(row.device_id),
    sessionId: row.session_id ? text(row.session_id) : null,
    level: text(row.level) as AgentLogLevel, code: text(row.code),
    message: text(row.message), deviceUptimeMs: numberOrNull(row.device_uptime_ms),
    recordedAt: Number(row.recorded_at),
  };
}

export async function recordAgentLog(db: DatabaseBinding, input: {
  deviceId: string; sessionId: string; level?: unknown; code?: unknown;
  message?: unknown; deviceUptimeMs?: unknown;
}) {
  const level = text(input.level).toUpperCase() as AgentLogLevel;
  if (!LEVELS.has(level)) throw new Error("Invalid agent log level");
  const code = redactAgentLogText(input.code, 48).replace(/[^A-Z0-9_.-]/gi, "_").toUpperCase();
  if (!code) throw new Error("Agent log code is required");
  const message = redactAgentLogText(input.message);
  const uptime = typeof input.deviceUptimeMs === "number" && Number.isSafeInteger(input.deviceUptimeMs) && input.deviceUptimeMs >= 0
    ? Math.min(input.deviceUptimeMs, 2_147_483_647) : null;
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO device_agent_logs
    (device_id, session_id, level, code, message, device_uptime_ms, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).bind(input.deviceId, input.sessionId, level, code, message, uptime, now).first<Row>();
  await db.prepare(`DELETE FROM device_agent_logs WHERE device_id = ? AND id NOT IN (
    SELECT id FROM device_agent_logs WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 500
  )`).bind(input.deviceId, input.deviceId).run();
  if (!row) throw new Error("Agent log was not recorded");
  return mapLog(row);
}

export async function listAgentLogs(db: DatabaseBinding, deviceId: string, limit = 100) {
  const boundedLimit = Math.max(1, Math.min(200, Math.round(limit)));
  const result = await db.prepare(`SELECT * FROM device_agent_logs WHERE device_id = ?
    ORDER BY recorded_at DESC, id DESC LIMIT ?`).bind(deviceId, boundedLimit).all<Row>();
  return (result.results ?? []).map(mapLog);
}

export async function searchAgentLogs(db: DatabaseBinding, deviceId: string, input: {
  limit?: number; level?: string | null; query?: string | null;
} = {}) {
  const boundedLimit = Math.max(1, Math.min(200, Number.isFinite(input.limit) ? Math.round(input.limit!) : 100));
  const level = typeof input.level === "string" && LEVELS.has(input.level.toUpperCase() as AgentLogLevel)
    ? input.level.toUpperCase() : null;
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 80) : "";
  const result = await db.prepare(`SELECT * FROM device_agent_logs
    WHERE device_id = ? AND (? IS NULL OR level = ?)
      AND (? = '' OR instr(lower(code || ' ' || message), lower(?)) > 0)
    ORDER BY recorded_at DESC, id DESC LIMIT ?
  `).bind(deviceId, level, level, query, query, boundedLimit).all<Row>();
  return (result.results ?? []).map(mapLog);
}
