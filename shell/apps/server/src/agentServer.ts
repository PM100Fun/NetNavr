import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { CodexAgent } from "@netnavr/shell-codex-client";
import { MockAgent, ModelRouter } from "@netnavr/shell-model-router";
import {
  parseClientMessage,
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type ApprovalPolicy,
  type ClientMessage,
  type RunRequest,
  type SandboxMode,
  type ShellEvent
} from "@netnavr/shell-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 128 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export type AgentServerOptions = {
  host?: string;
  port?: number;
  workspaceRoot?: string;
  sessionToken?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
};

export type AgentServerHandle = {
  host: string;
  port: number;
  url: string;
  webSocketUrl: string;
  workspaceRoot: string;
  sessionToken: string;
  close: () => Promise<void>;
};

export async function startAgentServer(options: AgentServerOptions = {}): Promise<AgentServerHandle> {
  const host = normalizeLoopbackHost(options.host);
  const port = normalizePort(options.port ?? process.env.PORT);
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? process.env.NETNAVR_SHELL_WORKSPACE);
  const sessionToken = normalizeSessionToken(options.sessionToken ?? process.env.NETNAVR_SHELL_SESSION_TOKEN);
  const sandboxMode = options.sandboxMode ?? "read-only";
  const approvalPolicy = options.approvalPolicy ?? "never";

  const router = new ModelRouter();
  router.register(new MockAgent());
  router.register(new CodexAgent());

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      writeJson(response, 200, { ok: true, providers: router.providers() });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/providers") {
      writeJson(response, 200, { providers: router.providers() });
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    handleProtocols: (protocols) => (protocols.has(SHELL_WEBSOCKET_PROTOCOL) ? SHELL_WEBSOCKET_PROTOCOL : false)
  });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const offeredProtocols = parseWebSocketProtocols(request.headers["sec-websocket-protocol"]);

    if (
      requestUrl.pathname !== "/ws" ||
      !offeredProtocols.includes(SHELL_WEBSOCKET_PROTOCOL) ||
      !hasValidSessionProtocol(offeredProtocols, sessionToken)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("connection", (socket) => {
    let activeAbort: AbortController | null = null;
    send(socket, { type: "shell.ready", providers: router.providers(), workspace: workspaceRoot });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send(socket, { type: "log", level: "error", message: "Binary client messages are not supported" });
        return;
      }

      void handleClientMessage(data, socket, {
        getActiveAbort: () => activeAbort,
        setActiveAbort: (controller) => {
          activeAbort = controller;
        },
        router,
        workspaceRoot,
        sandboxMode,
        approvalPolicy
      }).catch((error: unknown) => {
        send(socket, {
          type: "log",
          level: "error",
          message: error instanceof Error ? error.message : "Unable to handle client message"
        });
      });
    });

    socket.on("close", () => {
      activeAbort?.abort();
      activeAbort = null;
    });

    socket.on("error", () => {
      activeAbort?.abort();
      activeAbort = null;
    });
  });

  await listen(server, host, port);
  const actualPort = getListeningPort(server);
  const urlHost = host === "::1" ? "[::1]" : host;

  return {
    host,
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    webSocketUrl: `ws://${urlHost}:${actualPort}/ws`,
    workspaceRoot,
    sessionToken,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((wssError) => {
          if (wssError) {
            reject(wssError);
            return;
          }
          server.close((serverError) => {
            if (serverError) reject(serverError);
            else resolve();
          });
        });
      });
    }
  };
}

type MessageContext = {
  getActiveAbort: () => AbortController | null;
  setActiveAbort: (controller: AbortController | null) => void;
  router: ModelRouter;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
};

async function handleClientMessage(data: RawData, socket: WebSocket, context: MessageContext): Promise<void> {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(data.toString());
  } catch {
    send(socket, { type: "log", level: "error", message: "Client message must be valid JSON" });
    return;
  }

  const parsed = parseClientMessage(rawMessage);
  if (!parsed.ok) {
    send(socket, { type: "log", level: "error", message: parsed.error });
    return;
  }

  const message: ClientMessage = parsed.value;
  if (message.type === "cancel") {
    context.getActiveAbort()?.abort();
    context.setActiveAbort(null);
    send(socket, { type: "log", level: "warn", message: "Turn cancelled" });
    return;
  }

  context.getActiveAbort()?.abort();
  const activeAbort = new AbortController();
  context.setActiveAbort(activeAbort);

  const request: RunRequest = {
    ...message.request,
    cwd: context.workspaceRoot,
    sandboxMode: context.sandboxMode,
    approvalPolicy: context.approvalPolicy
  };
  const runId = randomUUID();

  send(socket, {
    type: "log",
    level: "info",
    message: `Run ${runId} routed to ${request.provider}`
  });

  try {
    for await (const event of context.router.run(request, activeAbort.signal)) {
      send(socket, event);
    }
  } catch (error) {
    send(socket, {
      type: "turn.failed",
      provider: request.provider,
      error: error instanceof Error ? error.message : "Agent run failed"
    });
  } finally {
    if (context.getActiveAbort() === activeAbort) context.setActiveAbort(null);
  }
}

function normalizeLoopbackHost(host: string | undefined): string {
  const normalized = host?.trim() || DEFAULT_HOST;
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(`Agent server host must be a numeric loopback address; received ${normalized}`);
  }
  return normalized;
}

function normalizePort(value: number | string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Agent server port must be an integer between 0 and 65535");
  }
  return port;
}

async function resolveWorkspaceRoot(configuredRoot: string | undefined): Promise<string> {
  const candidate = path.resolve(configuredRoot?.trim() || process.cwd());
  const resolved = await realpath(candidate);
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("Agent server workspace must be a directory");
  return resolved;
}

function normalizeSessionToken(token: string | undefined): string {
  if (token === undefined) return randomBytes(32).toString("base64url");
  const normalized = token.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(normalized)) {
    throw new Error("Agent server session token must be 32-256 base64url characters");
  }
  return normalized;
}

function parseWebSocketProtocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function hasValidSessionProtocol(protocols: readonly string[], sessionToken: string): boolean {
  const expected = `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`;
  return protocols.some((protocol) => safeEqual(protocol, expected));
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getListeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent server did not expose a TCP address");
  return address.port;
}

function send(socket: WebSocket, event: ShellEvent): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(event));
  } catch {
    socket.close(1011, "Unable to serialize server event");
  }
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}
