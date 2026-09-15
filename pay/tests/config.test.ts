import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PAY_HOST,
  DEFAULT_PAY_PORT,
  loadConfig,
} from "../src/config.ts";
import { AppError } from "../src/core/errors.ts";

test("Pay defaults to a dedicated numeric loopback endpoint", () => {
  assert.deepEqual(loadConfig({}), {
    host: DEFAULT_PAY_HOST,
    port: DEFAULT_PAY_PORT,
    merchantId: "merchant_demo",
    databasePath: "./data/netnavr-pay.sqlite",
    sandboxWebhookSecret: "local-sandbox-secret",
  });
  assert.equal(DEFAULT_PAY_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PAY_PORT, 8788);
});

test("Pay accepts explicit safe sandbox configuration", () => {
  assert.deepEqual(
    loadConfig({
      NETNAVR_PAY_HOST: "127.0.0.1",
      NETNAVR_PAY_PORT: "9100",
      NETNAVR_PAY_MERCHANT_ID: "merchant_test",
      NETNAVR_PAY_DB_PATH: "./tmp/pay.sqlite",
      NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET: "test-secret",
    }),
    {
      host: "127.0.0.1",
      port: 9100,
      merchantId: "merchant_test",
      databasePath: "./tmp/pay.sqlite",
      sandboxWebhookSecret: "test-secret",
    },
  );
});

test("Pay rejects non-loopback and hostname-based bind addresses", () => {
  for (const host of ["0.0.0.0", "localhost", "::1", "192.168.1.10"]) {
    assertInvalidConfig(
      { NETNAVR_PAY_HOST: host },
      `NETNAVR_PAY_HOST must be ${DEFAULT_PAY_HOST}`,
    );
  }
});

for (const name of ["NETNAVR_PAY_MERCHANT_ID", "NETNAVR_PAY_DB_PATH"]) {
  test(`Pay rejects explicitly blank ${name} in every environment`, () => {
    for (const value of ["", " ", "\t\r\n", "\u00a0"]) {
      for (const mode of [undefined, "development", "production"]) {
        assertInvalidConfig(
          { NODE_ENV: mode, NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET: "test-secret", [name]: value },
          `${name} must not be blank`,
        );
      }
    }
  });
}

test("Pay preserves explicit nonblank identity and database configuration", () => {
  for (const databasePath of ["./data with spaces/pay.sqlite", "  pay.sqlite  ", ":memory:"]) {
    const config = loadConfig({
      NETNAVR_PAY_MERCHANT_ID: " merchant_test ",
      NETNAVR_PAY_DB_PATH: databasePath,
    });
    assert.equal(config.merchantId, " merchant_test ");
    assert.equal(config.databasePath, databasePath);
  }
});

test("Pay rejects ambiguous or out-of-range ports", () => {
  for (const port of ["", "0", "65536", "8788.0", "1e3", " 8788", "not-a-port"]) {
    assertInvalidConfig(
      { NETNAVR_PAY_PORT: port },
      "NETNAVR_PAY_PORT is invalid",
    );
  }
});

test("Pay rejects explicitly blank webhook secrets in every environment", () => {
  for (const secret of ["", " ", "\t\r\n", "\u00a0"]) {
    for (const mode of [undefined, "development", "production"]) {
      assertInvalidConfig(
        { NODE_ENV: mode, NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET: secret },
        "NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET must not be blank",
      );
    }
  }
});

test("Pay preserves nonblank webhook secrets exactly", () => {
  const secret = "  test-secret\t";
  for (const mode of [undefined, "production"]) {
    assert.equal(
      loadConfig({ NODE_ENV: mode, NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET: secret })
        .sandboxWebhookSecret,
      secret,
    );
  }
});

test("Pay still requires an explicit production webhook secret", () => {
  assertInvalidConfig(
    { NODE_ENV: "production" },
    "NETNAVR_PAY_SANDBOX_WEBHOOK_SECRET is required in production",
  );
});

function assertInvalidConfig(
  environment: NodeJS.ProcessEnv,
  expectedMessage: string,
): void {
  assert.throws(
    () => loadConfig(environment),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "INVALID_CONFIG");
      assert.equal(error.httpStatus, 500);
      assert.equal(error.message, expectedMessage);
      return true;
    },
  );
}
