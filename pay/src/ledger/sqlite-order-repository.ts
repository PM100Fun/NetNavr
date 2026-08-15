import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import {
  canTransition,
  type PaymentOrder,
  type PaymentStatus,
} from "../core/payment.ts";
import type {
  ApplyPaymentEventInput,
  ApplyPaymentEventResult,
  OrderRepository,
} from "./order-repository.ts";

type OrderRow = {
  id: string;
  merchant_id: string;
  merchant_order_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  amount: number;
  currency: string;
  description: string;
  channel: string;
  status: PaymentStatus;
  external_id: string | null;
  checkout_url: string | null;
  created_at: string;
  updated_at: string;
};

type PaymentEventRow = {
  event_type: string;
  channel: string;
  order_id: string;
};

export class SqliteOrderRepository implements OrderRepository {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        merchant_order_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        external_id TEXT,
        checkout_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payment_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        channel TEXT NOT NULL,
        order_id TEXT NOT NULL REFERENCES payment_orders(id),
        received_at TEXT NOT NULL
      );
    `);
  }

  create(order: PaymentOrder): void {
    this.#database
      .prepare(`
        INSERT INTO payment_orders (
          id, merchant_id, merchant_order_id, idempotency_key,
          request_fingerprint, amount, currency, description, channel,
          status, external_id, checkout_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        order.id,
        order.merchantId,
        order.merchantOrderId,
        order.idempotencyKey,
        order.requestFingerprint,
        order.amount,
        order.currency,
        order.description,
        order.channel,
        order.status,
        order.externalId,
        order.checkoutUrl,
        order.createdAt,
        order.updatedAt,
      );
  }

  findById(id: string): PaymentOrder | null {
    const row = this.#database
      .prepare("SELECT * FROM payment_orders WHERE id = ?")
      .get(id) as OrderRow | undefined;
    return row ? mapOrder(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): PaymentOrder | null {
    const row = this.#database
      .prepare("SELECT * FROM payment_orders WHERE idempotency_key = ?")
      .get(idempotencyKey) as OrderRow | undefined;
    return row ? mapOrder(row) : null;
  }

  findByMerchantOrderId(merchantOrderId: string): PaymentOrder | null {
    const row = this.#database
      .prepare("SELECT * FROM payment_orders WHERE merchant_order_id = ?")
      .get(merchantOrderId) as OrderRow | undefined;
    return row ? mapOrder(row) : null;
  }

  attachChannelPayment(
    id: string,
    externalId: string,
    checkoutUrl: string,
    updatedAt: string,
  ): PaymentOrder {
    const result = this.#database
      .prepare(`
        UPDATE payment_orders
        SET external_id = ?, checkout_url = ?, status = 'PENDING', updated_at = ?
        WHERE id = ? AND status = 'CREATED'
      `)
      .run(externalId, checkoutUrl, updatedAt, id);

    if (result.changes !== 1) {
      throw new AppError(
        "ORDER_STATE_CONFLICT",
        "Order could not be moved to PENDING",
        409,
      );
    }

    return this.#requireOrder(id);
  }

  markFailed(id: string, updatedAt: string): PaymentOrder {
    this.#database
      .prepare(`
        UPDATE payment_orders
        SET status = 'FAILED', updated_at = ?
        WHERE id = ? AND status IN ('CREATED', 'PENDING')
      `)
      .run(updatedAt, id);
    return this.#requireOrder(id);
  }

  applyPaymentEvent(
    input: ApplyPaymentEventInput,
  ): ApplyPaymentEventResult {
    this.#database.exec("BEGIN IMMEDIATE");

    try {
      const eventResult = this.#database
        .prepare(`
          INSERT OR IGNORE INTO payment_events (
            event_id, event_type, channel, order_id, received_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          input.eventId,
          input.eventType,
          input.channel,
          input.orderId,
          input.receivedAt,
        );

      if (eventResult.changes === 0) {
        const existingEvent = this.#database
          .prepare(`
            SELECT event_type, channel, order_id
            FROM payment_events
            WHERE event_id = ?
          `)
          .get(input.eventId) as PaymentEventRow | undefined;

        if (
          !existingEvent ||
          existingEvent.event_type !== input.eventType ||
          existingEvent.channel !== input.channel ||
          existingEvent.order_id !== input.orderId
        ) {
          throw new AppError(
            "PAYMENT_EVENT_CONFLICT",
            "Payment event ID was already used for a different event",
            409,
          );
        }

        const order = this.#requireOrder(existingEvent.order_id);
        this.#database.exec("COMMIT");
        return { duplicate: true, order };
      }

      const current = this.#requireOrder(input.orderId);
      if (!canTransition(current.status, input.nextStatus)) {
        throw new AppError(
          "INVALID_ORDER_TRANSITION",
          `Cannot move order from ${current.status} to ${input.nextStatus}`,
          409,
        );
      }

      const updateResult = this.#database
        .prepare(`
          UPDATE payment_orders
          SET status = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `)
        .run(
          input.nextStatus,
          input.receivedAt,
          input.orderId,
          current.status,
        );

      if (updateResult.changes !== 1) {
        throw new AppError(
          "ORDER_STATE_CONFLICT",
          "Order changed while processing the payment event",
          409,
        );
      }

      const order = this.#requireOrder(input.orderId);
      this.#database.exec("COMMIT");
      return { duplicate: false, order };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #requireOrder(id: string): PaymentOrder {
    const order = this.findById(id);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Payment order was not found", 404);
    }
    return order;
  }
}

function mapOrder(row: OrderRow): PaymentOrder {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantOrderId: row.merchant_order_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    channel: row.channel,
    status: row.status,
    externalId: row.external_id,
    checkoutUrl: row.checkout_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
