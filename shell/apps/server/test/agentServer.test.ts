import assert from "node:assert/strict";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type ShellEvent
} from "@netnavr/shell-protocol";
import WebSocket, { type RawData } from "ws";

import { startAgentServer } from "../src/agentServer.js";

const sessionToken = "test_session_token_0123456789abcdef";

test("rejects non-loopback listeners", async () => {
  await assert.rejects(
    startAgentServer({ host: "0.0.0.0", port: 0, workspaceRoot: process.cwd(), sessionToken }),
    /loopback/
  );
});

test("requires a session token and keeps execution policy on the server", async (context) => {
  const workspaceRoot = await realpath(process.cwd());
  const server = await startAgentServer({ port: 0, workspaceRoot, sessionToken });
  context.after(() => server.close());

  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  await assertRejectedUpgrade(server.webSocketUrl, [SHELL_WEBSOCKET_PROTOCOL]);
  await assertRejectedUpgrade(server.webSocketUrl, [
    SHELL_WEBSOCKET_PROTOCOL,
    `${SHELL_WEBSOCKET_AUTH_PREFIX}wrong_session_token_0123456789abcdef`
  ]);

  const socket = new WebSocket(server.webSocketUrl, [
    SHELL_WEBSOCKET_PROTOCOL,
    `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`
  ]);
  context.after(() => socket.terminate());

  const readyMessage = waitForEvent(socket, (event) => event.type === "shell.ready");
  await once(socket, "open");
  assert.deepEqual(await readyMessage, {
    type: "shell.ready",
    providers: ["mock", "codex"],
    workspace: workspaceRoot
  });

  const invalidMessage = waitForEvent(socket, (event) => event.type === "log");
  socket.send("null");
  assert.match(getLogMessage(await invalidMessage), /object with a type/);

  const unsafeMessage = waitForEvent(socket, (event) => event.type === "log");
  socket.send(
    JSON.stringify({
      type: "run",
      request: {
        provider: "mock",
        prompt: "unsafe override",
        cwd: "/",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never"
      }
    })
  );
  assert.match(getLogMessage(await unsafeMessage), /unsupported fields/);

  const completedRun = collectUntil(socket, "turn.completed");
  socket.send(JSON.stringify({ type: "run", request: { provider: "mock", prompt: "hello" } }));
  const events = await completedRun;
  assert.ok(events.some((event) => event.type === "agent.delta"));

  socket.close();
  await once(socket, "close");
});

async function assertRejectedUpgrade(webSocketUrl: string, protocols: string[]): Promise<void> {
  const socket = new WebSocket(webSocketUrl, protocols);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => reject(new Error("Unauthenticated WebSocket unexpectedly opened")));
    socket.once("unexpected-response", (_request, response) => {
      assert.equal(response.statusCode, 401);
      response.resume();
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function waitForEvent(socket: WebSocket, predicate: (event: ShellEvent) => boolean): Promise<ShellEvent> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(data.toString()) as ShellEvent;
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

function collectUntil(socket: WebSocket, terminalType: ShellEvent["type"]): Promise<ShellEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ShellEvent[] = [];
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(data.toString()) as ShellEvent;
      events.push(event);
      if (event.type !== terminalType) return;
      cleanup();
      resolve(events);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };

    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

function getLogMessage(event: ShellEvent): string {
  assert.equal(event.type, "log");
  return event.message;
}
