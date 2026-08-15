import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { PaymentService } from "../src/application/payment-service.ts";
import { ChannelRegistry } from "../src/channels/channel-registry.ts";
import { SandboxChannel } from "../src/channels/sandbox-channel.ts";
import { createHttpServer } from "../src/http/server.ts";
import { SqliteOrderRepository } from "../src/ledger/sqlite-order-repository.ts";
import {
  PAY_SERVICE_NAME,
  PAY_SERVICE_VERSION,
} from "../src/version.ts";

test("Pay HTTP metadata matches the package version", async (t) => {
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

  await listen(server);
  t.after(async () => {
    await close(server);
    orders.close();
  });

  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const packageMetadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    name: PAY_SERVICE_NAME,
    version: PAY_SERVICE_VERSION,
    mode: "merchant-owned",
  });
  assert.equal(PAY_SERVICE_VERSION, packageMetadata.version);
});

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
