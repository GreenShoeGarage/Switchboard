import { databaseError, getDatabase } from "@/db";
import { TELEMETRY_MIN_INTERVAL_MS, TELEMETRY_RETENTION_PER_PIN } from "@/lib/device-model";
import { getDevice, getDevicePins } from "@/lib/registry-server";
import { listTelemetrySamples } from "@/lib/telemetry-server";

type Context = { params: Promise<{ id: string }> };

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const db = getDatabase();
    const device = await getDevice(db, id);
    if (!device) return Response.json({ error: "Device not found" }, { status: 404 });
    const url = new URL(request.url);
    const pinId = url.searchParams.get("pinId")?.slice(0, 8) || null;
    if (pinId && !(await getDevicePins(db, id)).some((pin) => pin.pinId === pinId && pin.capability.includes("ANALOG"))) {
      return Response.json({ error: "Analog pin not found in device profile" }, { status: 404 });
    }
    const limit = Number(url.searchParams.get("limit") ?? 240);
    const samples = await listTelemetrySamples(db, id, pinId, Number.isFinite(limit) ? limit : 240);
    if (url.searchParams.get("format") === "csv") {
      const rows = [
        ["recorded_at", "device_id", "pin_id", "sequence", "raw_adc_count", "voltage_v", "engineering_value", "engineering_unit"],
        ...samples.slice().reverse().map((sample) => [new Date(sample.recordedAt).toISOString(), sample.deviceId, sample.pinId, sample.sequence ?? "", sample.rawValue, sample.voltageValue, sample.engineeringValue, sample.engineeringUnit]),
      ];
      return new Response(rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="switchboard-${id.toLowerCase()}-${(pinId ?? "analog").toLowerCase()}-telemetry.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({
      samples,
      retention: { minimumIntervalMs: TELEMETRY_MIN_INTERVAL_MS, maximumSamplesPerPin: TELEMETRY_RETENTION_PER_PIN },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: databaseError(error) }, { status: 500 });
  }
}
