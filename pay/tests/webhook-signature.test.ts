import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/core/errors.ts";
import {
  signWebhook,
  verifyWebhookSignature,
} from "../src/security/webhook-signature.ts";

test("accepts an authentic webhook and rejects a modified body", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from('{"event":"paid"}');
  const signature = signWebhook(body, secret);

  assert.doesNotThrow(() => verifyWebhookSignature(body, signature, secret));
  assert.throws(
    () =>
      verifyWebhookSignature(
        Buffer.from('{"event":"refunded"}'),
        signature,
        secret,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_WEBHOOK_SIGNATURE",
  );
});
