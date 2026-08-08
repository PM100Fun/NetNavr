import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CORE_API_VERSION,
  CORE_HOST,
  CORE_SERVICE,
  CORE_VERSION,
  startCore,
  type RunningCore,
} from "../src/server.ts";

async function withCore(run: (core: RunningCore) => Promise<void>): Promise<void> {
  const core = await startCore({ port: 0 });
  try {
    await run(core);
  } finally {
    await core.close();
  }
}

test("GET /v1/health returns the stable health contract", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/v1/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");

    const payload = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), [
      "service",
      "status",
      "apiVersion",
      "version",
      "uptimeSeconds",
    ]);
    assert.equal(payload.service, CORE_SERVICE);
    assert.equal(payload.status, "ok");
    assert.equal(payload.apiVersion, CORE_API_VERSION);
    assert.equal(payload.version, CORE_VERSION);
    assert.equal(typeof payload.uptimeSeconds, "number");
    assert.ok(Number.isInteger(payload.uptimeSeconds));
    assert.ok((payload.uptimeSeconds as number) >= 0);
  });
});

test("unknown routes return a structured 404", async () => {
  await withCore(async (core) => {
    const response = await fetch(`${core.origin}/not-a-route`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  });
});

test("the server binds only to loopback and close is idempotent", async () => {
  const core = await startCore({ port: 0 });

  assert.equal(core.host, CORE_HOST);
  assert.match(core.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  await Promise.all([core.close(), core.close()]);
  await core.close();

  await assert.rejects(fetch(`${core.origin}/v1/health`));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`the command exits cleanly after ${signal}`, async () => {
    const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const child = spawn(process.execPath, [entrypoint], {
      env: {
        ...process.env,
        NETNAVR_CORE_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      while (!stdout.includes('"event":"started"')) {
        await Promise.race([
          once(child.stdout, "data"),
          once(child, "exit").then(() => {
            throw new Error(`core exited before startup: ${stderr}`);
          }),
        ]);
      }

      assert.equal(child.kill(signal), true);
      const [exitCode, exitSignal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];

      assert.equal(exitCode, 0, stderr);
      assert.equal(exitSignal, null);
      assert.match(stdout, new RegExp(`"event":"stopped".*"signal":"${signal}"`));
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });
}
