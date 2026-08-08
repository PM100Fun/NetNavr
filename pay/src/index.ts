import { PaymentService } from "./application/payment-service.ts";
import { ChannelRegistry } from "./channels/channel-registry.ts";
import { SandboxChannel } from "./channels/sandbox-channel.ts";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http/server.ts";
import { SqliteOrderRepository } from "./ledger/sqlite-order-repository.ts";

const config = loadConfig();
const orders = new SqliteOrderRepository(config.databasePath);
const channels = new ChannelRegistry([new SandboxChannel()]);
const payments = new PaymentService({
  merchantId: config.merchantId,
  orders,
  channels,
});
const server = createHttpServer({
  payments,
  sandboxWebhookSecret: config.sandboxWebhookSecret,
});

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      event: "netnavr.pay.started",
      address: `http://${config.host}:${config.port}`,
      merchantId: config.merchantId,
    }),
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ event: "netnavr.pay.stopping", signal }));
  server.close(() => {
    orders.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
