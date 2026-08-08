import {
  CORE_API_VERSION,
  CORE_HOST,
  CORE_SERVICE,
  CORE_VERSION,
  DEFAULT_CORE_PORT,
  startCore,
} from "./server.ts";

function portFromEnvironment(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CORE_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new RangeError("NETNAVR_CORE_PORT must be an integer between 0 and 65535");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("NETNAVR_CORE_PORT must be an integer between 0 and 65535");
  }

  return port;
}

async function main(): Promise<void> {
  const core = await startCore({
    port: portFromEnvironment(process.env.NETNAVR_CORE_PORT),
  });

  let stopping = false;

  const stop = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopping) {
      return;
    }
    stopping = true;

    void core
      .close()
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ event: "stopped", service: CORE_SERVICE, signal })}\n`,
        );
      })
      .catch((error: unknown) => {
        process.exitCode = 1;
        process.stderr.write(
          `${JSON.stringify({
            event: "shutdown_failed",
            service: CORE_SERVICE,
            signal,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.stdout.write(
    `${JSON.stringify({
      event: "started",
      service: CORE_SERVICE,
      apiVersion: CORE_API_VERSION,
      version: CORE_VERSION,
      host: CORE_HOST,
      port: core.port,
    })}\n`,
  );
}

await main().catch((error: unknown) => {
  process.exitCode = 1;
  process.stderr.write(
    `${JSON.stringify({
      event: "startup_failed",
      service: CORE_SERVICE,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
});
