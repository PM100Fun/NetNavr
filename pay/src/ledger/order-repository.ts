import type { PaymentOrder, PaymentStatus } from "../core/payment.ts";

export type ApplyPaymentEventInput = {
  eventId: string;
  eventType: string;
  channel: string;
  orderId: string;
  nextStatus: PaymentStatus;
  receivedAt: string;
};

export type ApplyPaymentEventResult = {
  duplicate: boolean;
  order: PaymentOrder;
};

export interface OrderRepository {
  create(order: PaymentOrder): void;
  findById(id: string): PaymentOrder | null;
  findByIdempotencyKey(idempotencyKey: string): PaymentOrder | null;
  findByMerchantOrderId(merchantOrderId: string): PaymentOrder | null;
  attachChannelPayment(
    id: string,
    externalId: string,
    checkoutUrl: string,
    updatedAt: string,
  ): PaymentOrder;
  markFailed(id: string, updatedAt: string): PaymentOrder;
  applyPaymentEvent(input: ApplyPaymentEventInput): ApplyPaymentEventResult;
  close(): void;
}
