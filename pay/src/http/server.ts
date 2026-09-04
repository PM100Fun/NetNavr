import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { PaymentService } from "../application/payment-service.ts";
import { AppError, asAppError } from "../core/errors.ts";
import type { PaymentOrder } from "../core/payment.ts";
import { verifyWebhookSignature } from "../security/webhook-signature.ts";
import { PAY_SERVICE_NAME, PAY_SERVICE_VERSION } from "../version.ts";

export const PAY_MAX_HEADER_BYTES = 8 * 1024;
export const PAY_MAX_REQUEST_BODY_BYTES = 1_048_576;
export const PAY_HEADERS_TIMEOUT_MS = 5_000;
export const PAY_REQUEST_TIMEOUT_MS = 10_000;
export const PAY_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const PAY_MAX_REQUESTS_PER_SOCKET = 100;

export function createHttpServer(options: {
  payments: PaymentService;
  sandboxWebhookSecret: string;
}) {
  const server = createServer(
    {
      headersTimeout: PAY_HEADERS_TIMEOUT_MS,
      insecureHTTPParser: false,
      keepAliveTimeout: PAY_KEEP_ALIVE_TIMEOUT_MS,
      maxHeaderSize: PAY_MAX_HEADER_BYTES,
      requestTimeout: PAY_REQUEST_TIMEOUT_MS,
      requireHostHeader: true,
    },
    async (request, response) => {
      try {
        await routeRequest(request, response, options);
      } catch (error) {
        const appError = asAppError(error);
        sendJson(
          response,
          appError.httpStatus,
          {
            error: {
              code: appError.code,
              message: appError.message,
              ...(appError.details ? { details: appError.details } : {}),
            },
          },
          shouldCloseConnection(appError) ? { connection: "close" } : {},
        );
      }
    },
  );
  server.maxRequestsPerSocket = PAY_MAX_REQUESTS_PER_SOCKET;
  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    payments: PaymentService;
    sandboxWebhookSecret: string;
  },
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://netnavr.local");
  const routeAcceptsBody =
    method === "POST" &&
    (url.pathname === "/v1/orders" || url.pathname === "/v1/webhooks/sandbox");

  if (!routeAcceptsBody && requestHasBody(request)) {
    request.resume();
    throw new AppError(
      "REQUEST_BODY_NOT_ALLOWED",
      "This Pay route does not accept a request body",
      413,
    );
  }
  if (routeAcceptsBody) {
    assertDeclaredBodyWithinLimit(request);
  }

  if (method === "GET" && url.pathname === "/") {
    sendJson(response, 200, {
      name: PAY_SERVICE_NAME,
      version: PAY_SERVICE_VERSION,
      mode: "merchant-owned",
    });
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/orders") {
    const idempotencyKey = headerValue(request, "idempotency-key");
    if (!idempotencyKey) {
      throw new AppError(
        "MISSING_IDEMPOTENCY_KEY",
        "Idempotency-Key header is required",
        422,
      );
    }

    const body = await readJsonBody(request);
    const result = await options.payments.createOrder(
      body as {
        merchantOrderId: string;
        amount: number;
        currency?: string;
        description: string;
        channel?: string;
      },
      idempotencyKey,
    );
    sendJson(response, result.reused ? 200 : 201, {
      reused: result.reused,
      order: publicOrder(result.order),
    });
    return;
  }

  const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch) {
    const order = options.payments.getOrder(decodeURIComponent(orderMatch[1]));
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/webhooks/sandbox") {
    const rawBody = await readBody(request);
    verifyWebhookSignature(
      rawBody,
      headerValue(request, "x-netnavr-signature"),
      options.sandboxWebhookSecret,
    );
    const body = parseJson(rawBody) as {
      id?: string;
      type?: string;
      data?: { orderId?: string; externalId?: string };
    };

    if (
      body.type !== "payment.succeeded" ||
      !body.id ||
      !body.data?.orderId ||
      !body.data.externalId
    ) {
      throw new AppError(
        "INVALID_WEBHOOK",
        "Webhook payload is incomplete or unsupported",
        422,
      );
    }

    const result = options.payments.handlePaymentSucceeded({
      eventId: body.id,
      channel: "sandbox",
      orderId: body.data.orderId,
      externalId: body.data.externalId,
    });
    sendJson(response, 200, {
      received: true,
      duplicate: result.duplicate,
      order: publicOrder(result.order),
    });
    return;
  }

  throw new AppError("ROUTE_NOT_FOUND", "Route was not found", 404);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return parseJson(await readBody(request));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  assertDeclaredBodyWithinLimit(request);

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > PAY_MAX_REQUEST_BODY_BYTES) {
      throw bodyTooLargeError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function assertDeclaredBodyWithinLimit(request: IncomingMessage): void {
  const declaredLength = request.headers["content-length"];
  if (declaredLength === undefined) return;

  const values = Array.isArray(declaredLength)
    ? declaredLength
    : [declaredLength];
  const tooLarge = values.some((value) => {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return true;
    const length = Number(normalized);
    return !Number.isSafeInteger(length) || length > PAY_MAX_REQUEST_BODY_BYTES;
  });
  if (!tooLarge) return;

  request.resume();
  throw bodyTooLargeError();
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

function publicOrder(order: PaymentOrder) {
  return {
    id: order.id,
    merchantId: order.merchantId,
    merchantOrderId: order.merchantOrderId,
    amount: order.amount,
    currency: order.currency,
    description: order.description,
    channel: order.channel,
    status: order.status,
    externalId: order.externalId,
    checkoutUrl: order.checkoutUrl,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  additionalHeaders: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...additionalHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function requestHasBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;

  const contentLength = request.headers["content-length"];
  if (contentLength === undefined) return false;

  const values = Array.isArray(contentLength) ? contentLength : [contentLength];
  return values.some((value) => {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return true;
    const length = Number(normalized);
    return !Number.isSafeInteger(length) || length > 0;
  });
}

function bodyTooLargeError(): AppError {
  return new AppError("BODY_TOO_LARGE", "Request body exceeds 1 MiB", 413);
}

function shouldCloseConnection(error: AppError): boolean {
  return (
    error.code === "BODY_TOO_LARGE" ||
    error.code === "REQUEST_BODY_NOT_ALLOWED"
  );
}
