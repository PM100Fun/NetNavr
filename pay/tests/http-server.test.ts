import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { test } from "node:test";
import { PaymentService } from "../src/application/payment-service.ts";
import { ChannelRegistry } from "../src/channels/channel-registry.ts";
import { SandboxChannel } from "../src/channels/sandbox-channel.ts";
import {
  createHttpServer,
  PAY_HEADERS_TIMEOUT_MS,
  PAY_KEEP_ALIVE_TIMEOUT_MS,
  PAY_MAX_HEADER_BYTES,
  PAY_MAX_REQUEST_BODY_BYTES,
  PAY_MAX_REQUESTS_PER_SOCKET,
  PAY_REQUEST_TIMEOUT_MS,
} from "../src/http/server.ts";
import { SqliteOrderRepository } from "../src/ledger/sqlite-order-repository.ts";
import {
  PAY_SERVICE_NAME,
  PAY_SERVICE_VERSION,
} from "../src/version.ts";

test("Pay HTTP metadata matches the package version", async () => {
  await withPayServer(async (_server, origin) => {
    const response = await fetch(`${origin}/`);
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), {
      name: PAY_SERVICE_NAME,
      version: PAY_SERVICE_VERSION,
      mode: "merchant-owned",
    });
    assert.equal(PAY_SERVICE_VERSION, packageMetadata.version);
  });
});

test("bounds Pay HTTP parser and connection resources", async () => {
  await withPayServer(async (server) => {
    assert.equal(server.headersTimeout, PAY_HEADERS_TIMEOUT_MS);
    assert.equal(server.requestTimeout, PAY_REQUEST_TIMEOUT_MS);
    assert.equal(server.keepAliveTimeout, PAY_KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(server.maxRequestsPerSocket, PAY_MAX_REQUESTS_PER_SOCKET);

    const address = server.address() as AddressInfo;
    const response = await sendRawHttpRequest(
      address.address,
      address.port,
      [
        "GET /health HTTP/1.1",
        `Host: ${address.address}:${address.port}`,
        `X-Oversized: ${"a".repeat(PAY_MAX_HEADER_BYTES)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    assert.match(response, /^HTTP\/1\.1 431 /);
  });
});

test("rejects bodies on bodyless Pay routes and closes the connection", async () => {
  await withPayServer(async (server) => {
    const address = server.address() as AddressInfo;
    const response = await sendRawHttpRequest(
      address.address,
      address.port,
      [
        "GET /health HTTP/1.1",
        `Host: ${address.address}:${address.port}`,
        "Content-Length: 1",
        "Connection: keep-alive",
        "",
        "x",
      ].join("\r\n"),
    );

    assert.match(response, /^HTTP\/1\.1 413 /);
    assert.match(response, /connection: close/i);
    assert.match(response, /cache-control: no-store/i);
    assert.match(response, /x-content-type-options: nosniff/i);
    assert.deepEqual(parseRawJsonBody(response), {
      error: {
        code: "REQUEST_BODY_NOT_ALLOWED",
        message: "This Pay route does not accept a request body",
      },
    });
  });
});

test("rejects declared Pay request bodies above one MiB", async () => {
  await withPayServer(async (server) => {
    const address = server.address() as AddressInfo;
    const response = await sendRawHttpRequest(
      address.address,
      address.port,
      [
        "POST /v1/orders HTTP/1.1",
        `Host: ${address.address}:${address.port}`,
        `Content-Length: ${PAY_MAX_REQUEST_BODY_BYTES + 1}`,
        "Content-Type: application/json",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"),
    );

    assert.match(response, /^HTTP\/1\.1 413 /);
    assert.match(response, /connection: close/i);
    assert.match(response, /cache-control: no-store/i);
    assert.match(response, /x-content-type-options: nosniff/i);
    assert.deepEqual(parseRawJsonBody(response), {
      error: {
        code: "BODY_TOO_LARGE",
        message: "Request body exceeds 1 MiB",
      },
    });
  });
});

async function withPayServer(
  run: (server: Server, origin: string) => Promise<void>,
): Promise<void> {
  const orders = new SqliteOrderRepository(":memory:");
  const payments = new PaymentService({
    merchantId: "merchant_http_test",
    orders,
    channels: new ChannelRegistry([new SandboxChannel()]),
  });
  const server = createHttpServer({
    payments,
    sandboxWebhookSecret: "http-test-secret",
  });
  let listening = false;

  try {
    await listen(server);
    listening = true;
    const address = server.address() as AddressInfo;
    await run(server, `http://${address.address}:${address.port}`);
  } finally {
    if (listening) await close(server);
    orders.close();
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sendRawHttpRequest(
  host: string,
  port: number,
  request: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => socket.end(request));
    let response = "";

    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("Timed out waiting for HTTP response")),
    );
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(response));
  });
}

function parseRawJsonBody(response: string): unknown {
  const separator = response.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1);
  return JSON.parse(response.slice(separator + 4));
}
