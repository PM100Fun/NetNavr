export const PAYMENT_STATUS = {
  CREATED: "CREATED",
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type PaymentStatus =
  (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export type PaymentOrder = {
  id: string;
  merchantId: string;
  merchantOrderId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  amount: number;
  currency: string;
  description: string;
  channel: string;
  status: PaymentStatus;
  externalId: string | null;
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

const ALLOWED_TRANSITIONS: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  CREATED: new Set(["PENDING", "FAILED", "CANCELLED"]),
  PENDING: new Set(["PAID", "FAILED", "CANCELLED"]),
  PAID: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};

export function canTransition(
  current: PaymentStatus,
  next: PaymentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[current].has(next);
}
