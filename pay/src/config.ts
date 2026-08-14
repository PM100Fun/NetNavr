import { AppError } from "./core/errors.ts";

export const DEFAULT_PAY_HOST = "127.0.0.1";
export const DEFAULT_PAY_PORT = 8788;

export type NetNavrPayConfig = {
  host: typeof DEFAULT_PAY_HOST;
  port: number;
  merchantId: string;
  databasePath: string;
  sandboxWebhookSecret: string;
};

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): NetNavrPayConfig {
  const host = environment.NETNAVR_PAY_HOST ?? DEFAULT_PAY_HOST;
  if (host !== DEFAULT_PAY_HOST) {
    throw new AppError(
      "INVALID_CONFIG",
      `NETNAVR_PAY_HOST must be ${DEFAULT_PAY_HOST}`,
      500,
    );
  }

  const rawPort = environment.NETNAVR_PAY_PORT ?? String(DEFAULT_PAY_PORT);
  if (!/^\d+$/.test(rawPort)) {
    throw new AppError("INVALID_CONFIG", "NETNAVR_PAY_PORT is invalid", 500);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError("INVALID_CONFIG", "NETNAVR_PAY_PORT is invalid", 500);
  }

  const merchantId = environment.NETNAVR_PAY_MERCHANT_ID ?? "merchant_demo";
  const sandboxWebhookSecret =
    environment.NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET ?? "local-sandbox-secret";

  if (
    environment.NODE_ENV === "production" &&
    sandboxWebhookSecret === "local-sandbox-secret"
  ) {
    throw new AppError(
      "INVALID_CONFIG",
      "NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET is required in production",
      500,
    );
  }

  return {
    host,
    port,
    merchantId,
    databasePath: environment.NETNAVR_PAY_DB_PATH ?? "./data/netnavr-pay.sqlite",
    sandboxWebhookSecret,
  };
}
