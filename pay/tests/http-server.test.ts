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
import { signWebhook } from "../src/security/webhook-signature.ts";
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

const validOrder = { merchantOrderId: "http-order", amount: 100, description: "Test" };

test("rejects invalid order JSON types without consuming the idempotency key", async () => {
  await withPayServer(async (_server, origin) => {
    for (const value of [
      null, [], true, 1, "order",
      ...["merchantOrderId", "description", "currency", "channel"].flatMap(
        (field) => [null, 42, true, [], {}].map(
          (invalid) => ({ ...validOrder, [field]: invalid }),
        ),
      ),
      { ...validOrder, amount: "100" },
    ]) {
      const response = await postJson(origin, "/v1/orders", value);
      assert.equal(response.status, 422, JSON.stringify(value));
      assert.equal((await response.json()).error.code, "INVALID_ORDER");
    }
    const created = await postJson(origin, "/v1/orders", validOrder);
    assert.equal(created.status, 201);
    const first = await created.json();
    assert.equal(first.order.status, "PENDING");
    const replay = await postJson(origin, "/v1/orders", validOrder);
    assert.equal(replay.status, 200);
    const second = await replay.json();
    assert.equal(second.reused, true);
    assert.equal(second.order.id, first.order.id);
  });
});

test("rejects malformed signed webhook types before changing the order", async () => {
  await withPayServer(async (_server, origin) => {
    const created = await postJson(origin, "/v1/orders", validOrder);
    const { order } = await created.json();
    const validEvent = {
      id: "evt-http-validation",
      type: "payment.succeeded",
      data: { orderId: order.id, externalId: order.externalId },
    };
    const invalidEvents = [
      null, [], true, 42, "event",
      ...[null, [], true, 42, "data"].map((data) => ({ ...validEvent, data })),
      ...[null, [], {}, true, 42, "", "   "].flatMap((value) => [
        { ...validEvent, id: value },
        { ...validEvent, data: { ...validEvent.data, orderId: value } },
        { ...validEvent, data: { ...validEvent.data, externalId: value } },
      ]),
    ];
    for (const value of invalidEvents) {
      const response = await postJson(origin, "/v1/webhooks/sandbox", value, true);
      assert.equal(response.status, 422, JSON.stringify(value));
      assert.equal((await response.json()).error.code, "INVALID_WEBHOOK");
      const current = await fetch(`${origin}/v1/orders/${order.id}`);
      assert.equal((await current.json()).order.status, "PENDING");
    }
    const unsigned = await postJson(origin, "/v1/webhooks/sandbox", null);
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).error.code, "MISSING_WEBHOOK_SIGNATURE");
    for (const duplicate of [false, true]) {
      const paid = await postJson(origin, "/v1/webhooks/sandbox", validEvent, true);
      assert.equal(paid.status, 200);
      const result = await paid.json();
      assert.equal(result.duplicate, duplicate);
      assert.equal(result.order.status, "PAID");
    }
  });
});

test("rejects malformed order path encoding while preserving valid lookups", async () => {
  await withPayServer(async (_server, origin) => {
    const created = await postJson(origin, "/v1/orders", validOrder);
    assert.equal(created.status, 201);
    const { order } = await created.json();
    for (const id of ["%", "%2", "%GG", "%FF", "%C3%28", "%ED%A0%80"]) {
      const response = await fetch(`${origin}/v1/orders/${id}`);
      assert.equal(response.status, 400, id);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(await response.json(), {
        error: {
          code: "INVALID_ORDER_ID",
          message: "Order ID must use valid URL encoding",
        },
      });
    }
    const encodedId = Array.from(order.id as string)
      .map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    for (const id of [order.id, encodedId]) {
      const response = await fetch(`${origin}/v1/orders/${id}`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).order, order);
    }
    for (const id of ["missing", "%25", "%2525", "%E4%B8%AD"]) {
      const response = await fetch(`${origin}/v1/orders/${id}`);
      assert.equal(response.status, 404, id);
      assert.equal((await response.json()).error.code, "ORDER_NOT_FOUND");
    }
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
  });
});

const invalidUtf8 = [
  [0xff], [0x80], [0xc3], [0xc3, 0x28], [0xc0, 0xaf],
  [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80],
];

test("rejects invalid UTF-8 orders without consuming order identity", async () => {
  await withPayServer(async (_server, origin) => {
    for (const bytes of invalidUtf8) {
      const body = Buffer.concat([
        Buffer.from('{"merchantOrderId":"http-order","amount":100,"description":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]);
      await assertInvalidJson(await postBytes(origin, "/v1/orders", body));
    }
    const valid = { ...validOrder, description: "中文 café 😀 \uFFFD" };
    const body = Buffer.from(JSON.stringify(valid));
    await assertInvalidJson(await postBytes(origin, "/v1/orders",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])));
    const created = await postBytes(origin, "/v1/orders", body);
    assert.equal(created.status, 201);
    const first = await created.json();
    assert.equal(first.order.description, valid.description);
    const replay = await postBytes(origin, "/v1/orders", body);
    assert.equal(replay.status, 200);
    const second = await replay.json();
    assert.equal(second.reused, true);
    assert.deepEqual(second.order, first.order);
  });
});

test("verifies raw webhook bytes before rejecting invalid UTF-8", async () => {
  await withPayServer(async (_server, origin) => {
    const created = await postJson(origin, "/v1/orders", validOrder);
    assert.equal(created.status, 201);
    const { order } = await created.json();
    for (const bytes of invalidUtf8) {
      const body = Buffer.concat([
        Buffer.from('{"id":"'),
        Buffer.from(bytes),
        Buffer.from('","type":"payment.succeeded","data":' +
          JSON.stringify({ orderId: order.id, externalId: order.externalId }) + '}'),
      ]);
      const unsigned = await postBytes(origin, "/v1/webhooks/sandbox", body);
      assert.equal(unsigned.status, 401);
      assert.equal((await unsigned.json()).error.code, "MISSING_WEBHOOK_SIGNATURE");
      const wrongSignature = await fetch(origin + "/v1/webhooks/sandbox", {
        method: "POST",
        headers: { "x-netnavr-signature": signWebhook(Buffer.from("different"), "http-test-secret") },
        body,
      });
      assert.equal(wrongSignature.status, 401);
      assert.equal((await wrongSignature.json()).error.code, "INVALID_WEBHOOK_SIGNATURE");
      await assertInvalidJson(await postBytes(origin, "/v1/webhooks/sandbox", body, true));
      const current = await fetch(`${origin}/v1/orders/${order.id}`);
      assert.deepEqual((await current.json()).order, order);
    }
    const event = Buffer.from(JSON.stringify({
      id: "事件-😀-\uFFFD",
      type: "payment.succeeded",
      data: { orderId: order.id, externalId: order.externalId },
    }));
    for (const duplicate of [false, true]) {
      const response = await postBytes(origin, "/v1/webhooks/sandbox", event, true);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.duplicate, duplicate);
      assert.equal(result.order.status, "PAID");
    }
  });
});

async function assertInvalidJson(response: Response) {
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
  });
}

function postBytes(origin: string, route: string, body: Buffer, signed = false) {
  return fetch(origin + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "http-validation-key",
      ...(signed ? {
        "x-netnavr-signature": signWebhook(body, "http-test-secret"),
      } : {}),
    },
    body,
  });
}

function postJson(origin: string, route: string, value: unknown, signed = false) {
  const body = JSON.stringify(value);
  return fetch(origin + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "http-validation-key",
      ...(signed ? {
        "x-netnavr-signature": signWebhook(Buffer.from(body), "http-test-secret"),
      } : {}),
    },
    body,
  });
}

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
