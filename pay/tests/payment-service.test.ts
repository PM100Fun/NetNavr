import assert from "node:assert/strict";
import { test } from "node:test";
import { PaymentService } from "../src/application/payment-service.ts";
import { ChannelRegistry } from "../src/channels/channel-registry.ts";
import { SandboxChannel } from "../src/channels/sandbox-channel.ts";
import { AppError } from "../src/core/errors.ts";
import { SqliteOrderRepository } from "../src/ledger/sqlite-order-repository.ts";

function createFixture() {
  const orders = new SqliteOrderRepository(":memory:");
  let tick = 0;
  const payments = new PaymentService({
    merchantId: "merchant_test",
    orders,
    channels: new ChannelRegistry([new SandboxChannel()]),
    now: () => new Date(1_750_000_000_000 + tick++ * 1_000),
  });
  return { orders, payments };
}

test("creates a durable pending order and reuses an idempotent request", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  const request = {
    merchantOrderId: "order_1001",
    amount: 1_888,
    description: "Test order",
    channel: "sandbox",
  };
  const first = await fixture.payments.createOrder(request, "idem-order-1001");
  const second = await fixture.payments.createOrder(request, "idem-order-1001");

  assert.equal(first.reused, false);
  assert.equal(first.order.status, "PENDING");
  assert.equal(first.order.amount, 1_888);
  assert.match(first.order.externalId ?? "", /^sbx_/);
  assert.equal(second.reused, true);
  assert.equal(second.order.id, first.order.id);
});

test("rejects reuse of an idempotency key with a different payload", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1002",
      amount: 500,
      description: "First payload",
    },
    "idem-order-1002",
  );

  await assert.rejects(
    fixture.payments.createOrder(
      {
        merchantOrderId: "order_1002",
        amount: 700,
        description: "Changed payload",
      },
      "idem-order-1002",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("applies a successful payment event exactly once", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  const created = await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1003",
      amount: 2_000,
      description: "Webhook order",
    },
    "idem-order-1003",
  );
  const event = {
    eventId: "evt_1003",
    channel: "sandbox",
    orderId: created.order.id,
    externalId: created.order.externalId!,
  };

  const first = fixture.payments.handlePaymentSucceeded(event);
  const duplicate = fixture.payments.handlePaymentSucceeded(event);

  assert.equal(first.duplicate, false);
  assert.equal(first.order.status, "PAID");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.order.status, "PAID");
});

test("rejects a payment event ID reused for another order", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  const first = await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1005_a",
      amount: 1_000,
      description: "First webhook order",
    },
    "idem-order-1005-a",
  );
  const second = await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1005_b",
      amount: 1_500,
      description: "Second webhook order",
    },
    "idem-order-1005-b",
  );

  fixture.payments.handlePaymentSucceeded({
    eventId: "evt_shared_1005",
    channel: "sandbox",
    orderId: first.order.id,
    externalId: first.order.externalId!,
  });

  assert.throws(
    () =>
      fixture.payments.handlePaymentSucceeded({
        eventId: "evt_shared_1005",
        channel: "sandbox",
        orderId: second.order.id,
        externalId: second.order.externalId!,
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === "PAYMENT_EVENT_CONFLICT",
  );
  assert.equal(fixture.payments.getOrder(first.order.id).status, "PAID");
  assert.equal(fixture.payments.getOrder(second.order.id).status, "PENDING");
});

test("binds a duplicate event ID to its original type and channel", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  const created = await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1006",
      amount: 2_500,
      description: "Event identity order",
    },
    "idem-order-1006",
  );
  const originalEvent = {
    eventId: "evt_identity_1006",
    eventType: "payment.succeeded",
    channel: "sandbox",
    orderId: created.order.id,
    nextStatus: "PAID" as const,
    receivedAt: "2025-06-15T15:06:45.000Z",
  };

  fixture.orders.applyPaymentEvent(originalEvent);

  for (const conflict of [
    { eventType: "payment.refunded", channel: "sandbox" },
    { eventType: "payment.succeeded", channel: "another-channel" },
  ]) {
    assert.throws(
      () =>
        fixture.orders.applyPaymentEvent({
          ...originalEvent,
          ...conflict,
          receivedAt: "2025-06-15T15:07:45.000Z",
        }),
      (error: unknown) =>
        error instanceof AppError && error.code === "PAYMENT_EVENT_CONFLICT",
    );
  }
});

test("rejects a webhook carrying another payment identifier", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.orders.close());

  const created = await fixture.payments.createOrder(
    {
      merchantOrderId: "order_1004",
      amount: 900,
      description: "Protected order",
    },
    "idem-order-1004",
  );

  assert.throws(
    () =>
      fixture.payments.handlePaymentSucceeded({
        eventId: "evt_1004",
        channel: "sandbox",
        orderId: created.order.id,
        externalId: "sbx_wrong",
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === "EXTERNAL_ID_MISMATCH",
  );
  assert.equal(fixture.payments.getOrder(created.order.id).status, "PENDING");
});
