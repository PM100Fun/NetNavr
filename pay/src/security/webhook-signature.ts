import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../core/errors.ts";

export function signWebhook(body: Buffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

export function verifyWebhookSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): void {
  if (!signature) {
    throw new AppError(
      "MISSING_WEBHOOK_SIGNATURE",
      "x-netnavr-signature header is required",
      401,
    );
  }

  const expected = Buffer.from(signWebhook(body, secret));
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid", 401);
  }
}
