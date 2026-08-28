import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";

import next from "next";
import { WebSocket, WebSocketServer } from "ws";

import { setDatabase } from "@/db";
import { applySQLiteMigrations, createSQLiteBinding } from "@/db/sqlite";
import { DEVICE_ENROLLMENT_PATH, DEVICE_SOCKET_PATH, deviceGatewayMethodResponse, enforceDeviceGatewayRateLimit, isCommunityAuthPath, isFrameworkStaticAsset, pruneDeviceGatewayRateLimits } from "@/lib/device-gateway";
import { attachDeviceSocket } from "@/lib/device-socket-server";
import {
  authenticateOperatorSession,
  installationIsConfigured,
  OPERATOR_EMAIL_HEADER,
  OPERATOR_ROLE_HEADER,
  parseCookies,
  SESSION_COOKIE_NAME,
  TRUSTED_CLIENT_ADDRESS_HEADER,
} from "@/lib/operator-auth";

const development = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST?.trim() || "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
const trustProxy = process.env.SWITCHBOARD_TRUST_PROXY === "true";
const databasePath = process.env.SWITCHBOARD_DATABASE_PATH?.trim() || "./data/switchboard.db";
const migrationsPath = process.env.SWITCHBOARD_MIGRATIONS_PATH?.trim() || "./drizzle";

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

const database = createSQLiteBinding(resolve(databasePath));
await applySQLiteMigrations(database, resolve(migrationsPath));
setDatabase(database);

const application = next({ dev: development, hostname, port });
await application.prepare();
const handle = application.getRequestHandler();
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 32_768, perMessageDeflate: false });
const maintenanceTimer = setInterval(() => {
  void pruneDeviceGatewayRateLimits(database, Date.now() - 24 * 60 * 60 * 1_000)
    .catch((error) => console.error("[switchboard] rate-limit maintenance failed", error));
}, 60 * 60 * 1_000);
maintenanceTimer.unref();

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function trustedClientAddress(request: IncomingMessage) {
  if (trustProxy) {
    const forwarded = firstHeader(request.headers["x-forwarded-for"])?.split(",", 1)[0]?.trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return request.socket.remoteAddress?.slice(0, 128) || "address-unavailable";
}

function sanitizeAndStampHeaders(request: IncomingMessage) {
  delete request.headers[OPERATOR_EMAIL_HEADER];
  delete request.headers[OPERATOR_ROLE_HEADER];
  delete request.headers[TRUSTED_CLIENT_ADDRESS_HEADER];
  if (!trustProxy) {
    delete request.headers["x-forwarded-for"];
    delete request.headers["x-forwarded-proto"];
    delete request.headers["x-forwarded-host"];
  }
  request.headers[TRUSTED_CLIENT_ADDRESS_HEADER] = trustedClientAddress(request);
}

function absoluteRequestUrl(request: IncomingMessage) {
  const forwardedProtocol = trustProxy ? firstHeader(request.headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim() : null;
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const host = firstHeader(request.headers.host) || `localhost:${port}`;
  return new URL(request.url || "/", `${protocol}://${host}`);
}

function fetchHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function gatewayRequest(request: IncomingMessage) {
  return new Request(absoluteRequestUrl(request), { method: request.method, headers: fetchHeaders(request) });
}

async function writeFetchResponse(response: ServerResponse, fetchResponse: Response) {
  response.statusCode = fetchResponse.status;
  for (const [name, value] of fetchResponse.headers) response.setHeader(name, value);
  response.end(Buffer.from(await fetchResponse.arrayBuffer()));
}

function json(response: ServerResponse, status: number, payload: Record<string, unknown>) {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(payload));
}

function publicPath(pathname: string) {
  return pathname === DEVICE_ENROLLMENT_PATH || pathname === DEVICE_SOCKET_PATH ||
    pathname === "/health/live" || pathname === "/health/ready" ||
    isCommunityAuthPath(pathname) || isFrameworkStaticAsset(pathname) ||
    pathname.startsWith("/_next/") || pathname.startsWith("/firmware/") ||
    ["/favicon.svg", "/file.svg", "/globe.svg", "/window.svg"].includes(pathname);
}

function returnTo(url: URL) {
  const value = `${url.pathname}${url.search}`;
  return value.startsWith("//") ? "/" : value;
}

function originIsAllowed(request: IncomingMessage, url: URL) {
  const origin = firstHeader(request.headers.origin);
  if (!origin) return true;
  try { return new URL(origin).host === url.host; }
  catch { return false; }
}

const server = createServer(async (request, response) => {
  try {
    sanitizeAndStampHeaders(request);
    const url = absoluteRequestUrl(request);

    if (url.pathname === "/health/live") return json(response, 200, { status: "live" });
    if (url.pathname === "/health/ready") {
      const row = await database.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return json(response, row?.ok === 1 ? 200 : 503, { status: row?.ok === 1 ? "ready" : "unavailable" });
    }

    const gatewayKind = url.pathname === DEVICE_ENROLLMENT_PATH ? "enrollment" : url.pathname === DEVICE_SOCKET_PATH ? "socket" : null;
    if (gatewayKind) {
      const methodResponse = deviceGatewayMethodResponse(gatewayRequest(request), gatewayKind);
      if (methodResponse) return void await writeFetchResponse(response, methodResponse);
      const rateLimitResponse = await enforceDeviceGatewayRateLimit(database, gatewayRequest(request), gatewayKind);
      if (rateLimitResponse) return void await writeFetchResponse(response, rateLimitResponse);
      if (gatewayKind === "socket") return json(response, 426, { error: "WebSocket upgrade required", protocol: "switchboard.device.v1" });
    }

    const isPublic = publicPath(url.pathname);
    let operator = null;
    if (!isPublic) {
      const token = parseCookies(firstHeader(request.headers.cookie)).get(SESSION_COOKIE_NAME) ?? null;
      operator = await authenticateOperatorSession(database, token);
      if (!operator) {
        if (url.pathname.startsWith("/api/")) return json(response, 401, { error: "Operator authentication required" });
        const configured = await installationIsConfigured(database);
        const location = new URL(configured ? "/login" : "/setup", url);
        if (configured) location.searchParams.set("return_to", returnTo(url));
        response.writeHead(303, { location: location.toString(), "cache-control": "private, no-store" });
        return response.end();
      }
      request.headers[OPERATOR_EMAIL_HEADER] = operator.email;
      request.headers[OPERATOR_ROLE_HEADER] = operator.role;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET") && !originIsAllowed(request, url)) {
      return json(response, 403, { error: "Cross-origin request rejected" });
    }

    await handle(request, response);
  } catch (error) {
    console.error("[switchboard] request failed", error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

function rejectUpgrade(socket: Duplex, status: number, message: string, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify({ error: message });
  const reason = status === 405 ? "Method Not Allowed" : status === 429 ? "Too Many Requests" : status === 500 ? "Internal Server Error" : "Bad Request";
  const headers = Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${headers}\r\n${body}`);
}

server.on("upgrade", (request, socket, head) => {
  void (async () => {
    try {
      sanitizeAndStampHeaders(request);
      const url = absoluteRequestUrl(request);
      if (url.pathname !== DEVICE_SOCKET_PATH) return rejectUpgrade(socket, 400, "Unknown WebSocket endpoint");
      if (request.method !== "GET") return rejectUpgrade(socket, 405, "Method is not allowed", { Allow: "GET" });
      const limited = await enforceDeviceGatewayRateLimit(database, gatewayRequest(request), "socket");
      if (limited) return rejectUpgrade(socket, 429, "Device gateway rate limit exceeded", { "Retry-After": limited.headers.get("retry-after") ?? "60" });

      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request);
        attachDeviceSocket({
          send(payload) { if (webSocket.readyState === WebSocket.OPEN) webSocket.send(payload); },
          close(code, reason) { webSocket.close(code, reason); },
          onMessage(listener) {
            webSocket.on("message", (data, isBinary) => {
              if (isBinary) webSocket.close(4002, "Text messages required");
              else listener(data.toString());
            });
          },
          onClose(listener) { webSocket.on("close", (code, reason) => listener(code, reason.toString())); },
          onError(listener) { webSocket.on("error", listener); },
        }, database, {
          waitUntil(promise) { void promise.catch((error) => console.error("[switchboard] background task failed", error)); },
        });
      });
    } catch (error) {
      console.error("[switchboard] WebSocket upgrade failed", error);
      rejectUpgrade(socket, 500, "WebSocket upgrade failed");
    }
  })();
});

server.listen(port, hostname, () => {
  console.log(`[switchboard] Community server listening on http://${hostname}:${port}`);
  console.log(`[switchboard] SQLite database: ${resolve(databasePath)}`);
  if ((process.env.SWITCHBOARD_BOOTSTRAP_TOKEN?.trim().length ?? 0) < 24) {
    console.warn("[switchboard] SWITCHBOARD_BOOTSTRAP_TOKEN is not configured; first-run owner setup is disabled");
  }
});

function shutdown(signal: string) {
  console.log(`[switchboard] received ${signal}; shutting down`);
  clearInterval(maintenanceTimer);
  webSockets.close();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
