import assert from "node:assert/strict";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  SHELL_PROTOCOL_VERSION,
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type ShellEvent
} from "@netnavr/shell-protocol";
import WebSocket, { type RawData } from "ws";

import { startAgentServer } from "../src/agentServer.js";

const sessionToken = "test_session_token_0123456789abcdef";
const firstRequestId = "req_12345678-1234-4123-8123-123456789abc";
const secondRequestId = "req_22345678-1234-4123-8123-123456789abc";
const staleRunId = "run_32345678-1234-4123-8123-123456789abc";

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
    protocolVersion: SHELL_PROTOCOL_VERSION,
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
      requestId: firstRequestId,
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
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: firstRequestId,
      request: { provider: "mock", prompt: "hello" }
    })
  );
  const events = await completedRun;
  assert.ok(events.some((event) => event.type === "agent.delta"));
  const started = events.find((event) => event.type === "run.started");
  assert.equal(started?.requestId, firstRequestId);
  assert.match(started?.runId ?? "", /^run_[0-9a-f-]{36}$/);
  assert.ok(
    events.every((event) => !("runId" in event) || event.runId === started?.runId)
  );

  const activeStarted = waitForEvent(
    socket,
    (event) => event.type === "run.started" && event.requestId === secondRequestId
  );
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: secondRequestId,
      request: { provider: "mock", prompt: "keep running ".repeat(1_000) }
    })
  );
  const activeRun = await activeStarted;
  assert.equal(activeRun.type, "run.started");

  const rejectedRun = waitForEvent(
    socket,
    (event) => event.type === "run.rejected" && event.requestId === firstRequestId
  );
  socket.send(
    JSON.stringify({
      type: "run",
      requestId: firstRequestId,
      request: { provider: "mock", prompt: "must not replace the active run" }
    })
  );
  assert.deepEqual(await rejectedRun, {
    type: "run.rejected",
    requestId: firstRequestId,
    reason: "run_in_progress"
  });

  const progressAfterStaleCancel = waitForEvent(
    socket,
    (event) => event.type === "agent.delta" && event.runId === activeRun.runId
  );
  const rejectedCancel = waitForEvent(
    socket,
    (event) => event.type === "cancel.rejected" && event.runId === staleRunId
  );
  socket.send(JSON.stringify({ type: "cancel", runId: staleRunId }));
  assert.deepEqual(await rejectedCancel, {
    type: "cancel.rejected",
    runId: staleRunId,
    reason: "run_not_active"
  });
  await progressAfterStaleCancel;

  const cancelledRun = waitForEvent(
    socket,
    (event) => event.type === "run.cancelled" && event.runId === activeRun.runId
  );
  socket.send(JSON.stringify({ type: "cancel", runId: activeRun.runId }));
  assert.deepEqual(await cancelledRun, {
    type: "run.cancelled",
    runId: activeRun.runId
  });

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
