import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  CORE_SCHEMA_VERSION,
  CoreNodeStore,
  type CoreNodeIdentity,
} from "./node-store.ts";
import { acquireCoreRuntimeLock, type CoreRuntimeLock } from "./runtime-lock.ts";
import { prepareCoreStoragePath } from "./storage-permissions.ts";

export const CORE_SERVICE = "netnavr-core";
export const CORE_API_VERSION = "v1";
export const CORE_HOST = "127.0.0.1";
export const DEFAULT_CORE_PORT = 8786;
export const CORE_DATABASE_FILENAME = "core.sqlite";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof packageMetadata.version !== "string") {
  throw new TypeError("core/package.json must contain a string version");
}

export const CORE_VERSION = packageMetadata.version;

export interface CoreHealth {
  service: typeof CORE_SERVICE;
  status: "ok";
  apiVersion: typeof CORE_API_VERSION;
  version: string;
  uptimeSeconds: number;
}

export interface StartCoreOptions {
  port?: number;
  databasePath?: string;
}

export interface RunningCore {
  readonly host: typeof CORE_HOST;
  readonly port: number;
  readonly origin: string;
  readonly node: CoreNodeIdentity;
  close(): Promise<void>;
}

export function defaultCoreDatabasePath(): string {
  return join(homedir(), ".netnavr", "core", CORE_DATABASE_FILENAME);
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  startedAt: bigint,
  node: CoreNodeIdentity,
): void {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/v1/health") {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    const health: CoreHealth = {
      service: CORE_SERVICE,
      status: "ok",
      apiVersion: CORE_API_VERSION,
      version: CORE_VERSION,
      uptimeSeconds: Number(elapsedNanoseconds / 1_000_000_000n),
    };

    writeJson(response, 200, health);
    return;
  }

  if (request.method === "GET" && pathname === "/v1/node") {
    writeJson(response, 200, node);
    return;
  }

  writeJson(response, 404, {
    error: {
      code: "not_found",
      message: "Route not found",
    },
  });
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen({ host: CORE_HOST, port });
  });
}

export async function startCore(options: StartCoreOptions = {}): Promise<RunningCore> {
  const port = options.port ?? DEFAULT_CORE_PORT;
  validatePort(port);

  const requestedDatabasePath = options.databasePath ?? defaultCoreDatabasePath();
  let runtimeLock: CoreRuntimeLock | undefined;
  let databasePath = requestedDatabasePath;

  if (requestedDatabasePath !== ":memory:") {
    const storagePath = prepareCoreStoragePath(requestedDatabasePath);
    databasePath = storagePath.databasePath;
    runtimeLock = acquireCoreRuntimeLock(storagePath.dataDirectory);
  }

  let store: CoreNodeStore;
  try {
    store = new CoreNodeStore(databasePath);
  } catch (error) {
    runtimeLock?.release();
    throw error;
  }
  const node = store.getNodeIdentity();

  const startedAt = process.hrtime.bigint();
  const server = createServer((request, response) => {
    routeRequest(request, response, startedAt, node);
  });

  try {
    await listen(server, port);
  } catch (error) {
    closeRuntimeResources(store, runtimeLock);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeRuntimeResources(store, runtimeLock);
    throw new Error("core server did not bind to a TCP address");
  }

  const boundPort = (address as AddressInfo).port;
  let closePromise: Promise<void> | undefined;

  return {
    host: CORE_HOST,
    port: boundPort,
    origin: `http://${CORE_HOST}:${boundPort}`,
    node,
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }

      closePromise = new Promise<void>((resolve, reject) => {
        const finish = (serverError?: Error): void => {
          try {
            closeRuntimeResources(store, runtimeLock);
          } catch (runtimeError) {
            reject(runtimeError);
            return;
          }

          if (serverError) {
            reject(serverError);
            return;
          }
          resolve();
        };

        if (!server.listening) {
          finish();
          return;
        }

        server.close((error) => {
          finish(error ?? undefined);
        });
      });

      return closePromise;
    },
  };
}

function closeRuntimeResources(
  store: CoreNodeStore,
  runtimeLock: CoreRuntimeLock | undefined,
): void {
  let storageError: unknown;
  try {
    store.close();
  } catch (error) {
    storageError = error;
  }

  try {
    runtimeLock?.release();
  } catch (lockError) {
    if (storageError === undefined) {
      throw lockError;
    }
  }

  if (storageError !== undefined) {
    throw storageError;
  }
}

export {
  CORE_RUNTIME_ALREADY_RUNNING,
  CORE_RUNTIME_LOCK_FILENAME,
  CORE_RUNTIME_LOCK_INVALID,
  CoreRuntimeLockError,
} from "./runtime-lock.ts";
export {
  CORE_PRIVATE_DIRECTORY_MODE,
  CORE_PRIVATE_FILE_MODE,
} from "./storage-permissions.ts";
export { CORE_SCHEMA_VERSION };
