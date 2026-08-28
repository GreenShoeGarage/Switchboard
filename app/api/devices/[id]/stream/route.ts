import { getDatabase } from "@/db";
import { getTransportBundle } from "@/lib/device-auth";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const db = getDatabase();
  if (!(await getTransportBundle(db, id))) return Response.json({ error: "Device not found" }, { status: 404 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let lastSignature = "";
        try {
          for (let index = 0; index < 14 && !request.signal.aborted; index += 1) {
            const bundle = await getTransportBundle(db, id);
            if (!bundle) break;
            const latestSession = bundle.sessions[0];
            const latestSnapshot = bundle.snapshots[0];
            const latestLog = bundle.logs[0];
            const latestCommand = bundle.commands[0];
            const signature = `${bundle.device.updatedAt}:${latestSession?.lastHeartbeatAt ?? 0}:${latestSnapshot?.id ?? 0}:${latestLog?.id ?? 0}:${latestCommand?.id ?? ""}:${latestCommand?.status ?? ""}:${latestCommand?.completedAt ?? 0}`;
            if (signature !== lastSignature) {
              lastSignature = signature;
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(bundle)}\n\n`));
            } else {
              controller.enqueue(encoder.encode(`event: heartbeat\ndata: {"serverTime":${Date.now()}}\n\n`));
            }
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
          if (!request.signal.aborted) controller.enqueue(encoder.encode("event: reconnect\ndata: {}\n\n"));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Live stream failed";
          if (!request.signal.aborted) controller.enqueue(encoder.encode(`event: stream-error\ndata: ${JSON.stringify({ error: message })}\n\n`));
        } finally { if (!request.signal.aborted) controller.close(); }
      })();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
