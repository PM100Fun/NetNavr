import { createHash, randomUUID } from "node:crypto";
import { ChannelRegistry } from "../channels/channel-registry.ts";
import { AppError } from "../core/errors.ts";
import {
  PAYMENT_STATUS,
  type PaymentOrder,
} from "../core/payment.ts";
import type { OrderRepository } from "../ledger/order-repository.ts";

export type CreateOrderInput = {
  merchantOrderId: string;
  amount: number;
  currency?: string;
  description: string;
  channel?: string;
};

export type CreateOrderResult = {
  reused: boolean;
  order: PaymentOrder;
};

export type PaymentSucceededEvent = {
  eventId: string;
  channel: string;
  orderId: string;
  externalId: string;
};

export class PaymentService {
  readonly #merchantId: string;
  readonly #orders: OrderRepository;
  readonly #channels: ChannelRegistry;
  readonly #now: () => Date;

  constructor(options: {
    merchantId: string;
    orders: OrderRepository;
    channels: ChannelRegistry;
    now?: () => Date;
  }) {
    this.#merchantId = options.merchantId;
    this.#orders = options.orders;
    this.#channels = options.channels;
    this.#now = options.now ?? (() => new Date());
  }

  async createOrder(
    input: CreateOrderInput,
    idempotencyKey: string,
  ): Promise<CreateOrderResult> {
    const normalized = normalizeCreateOrder(input);
    validateIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintRequest(normalized);

    const existingByKey = this.#orders.findByIdempotencyKey(idempotencyKey);
    if (existingByKey) {
      if (existingByKey.requestFingerprint !== fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for a different request",
          409,
        );
      }
      return { reused: true, order: existingByKey };
    }

    if (this.#orders.findByMerchantOrderId(normalized.merchantOrderId)) {
      throw new AppError(
        "MERCHANT_ORDER_EXISTS",
        "merchantOrderId must be unique",
        409,
      );
    }

    const channel = this.#channels.get(normalized.channel);
    const timestamp = this.#now().toISOString();
    const order: PaymentOrder = {
      id: randomUUID(),
      merchantId: this.#merchantId,
      merchantOrderId: normalized.merchantOrderId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      amount: normalized.amount,
      currency: normalized.currency,
      description: normalized.description,
      channel: normalized.channel,
      status: PAYMENT_STATUS.CREATED,
      externalId: null,
      checkoutUrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#orders.create(order);

    try {
      const channelPayment = await channel.createPayment({
        orderId: order.id,
        merchantOrderId: order.merchantOrderId,
        amount: order.amount,
        currency: order.currency,
        description: order.description,
      });
      const pendingOrder = this.#orders.attachChannelPayment(
        order.id,
        channelPayment.externalId,
        channelPayment.checkoutUrl,
        this.#now().toISOString(),
      );
      return { reused: false, order: pendingOrder };
    } catch (error) {
      this.#orders.markFailed(order.id, this.#now().toISOString());
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        "CHANNEL_CREATE_FAILED",
        "The payment channel could not create the payment",
        502,
      );
    }
  }

  getOrder(id: string): PaymentOrder {
    const order = this.#orders.findById(id);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Payment order was not found", 404);
    }
    return order;
  }

  handlePaymentSucceeded(event: PaymentSucceededEvent): {
    duplicate: boolean;
    order: PaymentOrder;
  } {
    const order = this.getOrder(event.orderId);

    if (order.channel !== event.channel) {
      throw new AppError(
        "CHANNEL_MISMATCH",
        "Webhook channel does not match the order channel",
        409,
      );
    }
    if (order.externalId !== event.externalId) {
      throw new AppError(
        "EXTERNAL_ID_MISMATCH",
        "Webhook payment identifier does not match the order",
        409,
      );
    }

    return this.#orders.applyPaymentEvent({
      eventId: event.eventId,
      eventType: "payment.succeeded",
      channel: event.channel,
      orderId: event.orderId,
      nextStatus: PAYMENT_STATUS.PAID,
      receivedAt: this.#now().toISOString(),
    });
  }
}

function normalizeCreateOrder(input: CreateOrderInput): Required<CreateOrderInput> {
  const merchantOrderId = input.merchantOrderId?.trim();
  const description = input.description?.trim();
  const currency = (input.currency ?? "CNY").trim().toUpperCase();
  const channel = (input.channel ?? "sandbox").trim().toLowerCase();

  if (!merchantOrderId || !/^[A-Za-z0-9_-]{1,64}$/.test(merchantOrderId)) {
    throw new AppError(
      "INVALID_MERCHANT_ORDER_ID",
      "merchantOrderId must contain 1-64 letters, numbers, '_' or '-'",
      422,
    );
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new AppError(
      "INVALID_AMOUNT",
      "amount must be a positive integer in the currency's minor unit",
      422,
    );
  }
  if (!description || description.length > 128) {
    throw new AppError(
      "INVALID_DESCRIPTION",
      "description must contain 1-128 characters",
      422,
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AppError("INVALID_CURRENCY", "currency must be an ISO 4217 code", 422);
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(channel)) {
    throw new AppError("INVALID_CHANNEL", "channel name is invalid", 422);
  }

  return {
    merchantOrderId,
    amount: input.amount,
    currency,
    description,
    channel,
  };
}

function validateIdempotencyKey(value: string): void {
  if (!value || value.length < 8 || value.length > 128) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8-128 characters",
      422,
    );
  }
}

function fingerprintRequest(input: Required<CreateOrderInput>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: input.amount,
        channel: input.channel,
        currency: input.currency,
        description: input.description,
        merchantOrderId: input.merchantOrderId,
      }),
    )
    .digest("hex");
}
