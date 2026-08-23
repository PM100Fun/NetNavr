import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClientMessage,
  parseShellEvent,
  SHELL_PROTOCOL_VERSION,
  SHELL_WEBSOCKET_PROTOCOL,
} from "@netnavr/shell-protocol";

const requestId = "req_12345678-1234-4123-8123-123456789abc";
const runId = "run_22345678-1234-4123-8123-123456789abc";

test("protocol v2 requires validated request and run correlation IDs", () => {
  assert.equal(SHELL_PROTOCOL_VERSION, 2);
  assert.equal(SHELL_WEBSOCKET_PROTOCOL, "netnavr-shell-v2");

  assert.equal(
    parseClientMessage({
      type: "run",
      requestId,
      request: { provider: "mock", prompt: "hello" },
    }).ok,
    true,
  );
  assert.equal(
    parseClientMessage({
      type: "cancel",
      runId,
    }).ok,
    true,
  );

  for (const message of [
    { type: "run", request: { provider: "mock", prompt: "missing request ID" } },
    {
      type: "run",
      requestId: "req_not-a-uuid",
      request: { provider: "mock", prompt: "invalid request ID" },
    },
    { type: "cancel" },
    { type: "cancel", runId: "run_not-a-uuid" },
  ]) {
    assert.equal(parseClientMessage(message).ok, false);
  }
});

test("protocol v2 rejects incompatible or uncorrelated server events", () => {
  assert.equal(
    parseShellEvent({
      type: "shell.ready",
      protocolVersion: SHELL_PROTOCOL_VERSION,
      providers: ["mock"],
      workspace: "C:\\workspace",
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "shell.ready",
      protocolVersion: 1,
      providers: ["mock"],
      workspace: "C:\\workspace",
    }).ok,
    false,
  );
  assert.equal(
    parseShellEvent({
      type: "turn.completed",
      runId,
      provider: "mock",
      usage: null,
    }).ok,
    true,
  );
  assert.equal(
    parseShellEvent({
      type: "turn.completed",
      provider: "mock",
      usage: null,
    }).ok,
    false,
  );
});
