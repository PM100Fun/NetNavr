export type AgentProvider = "mock" | "codex";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type ShellRequestId = `req_${string}`;

export type ShellRunId = `run_${string}`;

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type RunRequest = {
  runId: ShellRunId;
  provider: AgentProvider;
  prompt: string;
  threadId?: string | null;
  cwd?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  reasoningEffort?: ReasoningEffort;
};

export type ClientRunRequest = Pick<
  RunRequest,
  "provider" | "prompt" | "threadId" | "model" | "reasoningEffort"
>;

export type AgentItem = {
  id: string;
  type: string;
  status?: "inProgress" | "completed" | "failed";
  title?: string;
  text?: string;
  raw?: unknown;
};

export type ShellEvent =
  | {
      type: "shell.ready";
      protocolVersion: typeof SHELL_PROTOCOL_VERSION;
      providers: AgentProvider[];
      workspace: string;
    }
  | {
      type: "run.started";
      requestId: ShellRequestId;
      runId: ShellRunId;
      provider: AgentProvider;
    }
  | {
      type: "run.rejected";
      requestId: ShellRequestId;
      reason: "run_in_progress";
    }
  | {
      type: "cancel.rejected";
      runId: ShellRunId;
      reason: "run_not_active";
    }
  | {
      type: "run.cancelled";
      runId: ShellRunId;
    }
  | {
      type: "thread.started";
      runId: ShellRunId;
      provider: AgentProvider;
      threadId: string;
    }
  | {
      type: "turn.started";
      runId: ShellRunId;
      provider: AgentProvider;
      threadId?: string | null;
    }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      runId: ShellRunId;
      provider: AgentProvider;
      item: AgentItem;
    }
  | {
      type: "agent.delta";
      runId: ShellRunId;
      provider: AgentProvider;
      text: string;
    }
  | {
      type: "turn.completed";
      runId: ShellRunId;
      provider: AgentProvider;
      threadId?: string | null;
      usage?: Usage | null;
    }
  | {
      type: "turn.failed";
      runId: ShellRunId;
      provider: AgentProvider;
      error: string;
    }
  | {
      type: "log";
      runId?: ShellRunId;
      level: "info" | "warn" | "error";
      message: string;
    };

export type ClientMessage =
  | {
      type: "run";
      requestId: ShellRequestId;
      request: ClientRunRequest;
    }
  | {
      type: "cancel";
      runId: ShellRunId;
    };

export const SHELL_PROTOCOL_VERSION = 2 as const;
export const SHELL_WEBSOCKET_PROTOCOL = `netnavr-shell-v${SHELL_PROTOCOL_VERSION}`;
export const SHELL_WEBSOCKET_AUTH_PREFIX = "netnavr-shell-auth.";

export type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

const agentProviders = new Set<AgentProvider>(["mock", "codex"]);
const reasoningEfforts = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
const itemStatuses = new Set<NonNullable<AgentItem["status"]>>(["inProgress", "completed", "failed"]);
const logLevels = new Set(["info", "warn", "error"] as const);
const requestIdPattern = /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runIdPattern = /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseClientMessage(value: unknown): ParseResult<ClientMessage> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return invalid("Message must be an object with a type");
  }

  if (value.type === "cancel") {
    if (!hasOnlyKeys(value, ["type", "runId"]) || !isRunId(value.runId)) {
      return invalid("Cancel message must target a valid run ID");
    }
    return { ok: true, value: { type: "cancel", runId: value.runId } };
  }

  if (
    value.type !== "run" ||
    !hasOnlyKeys(value, ["type", "requestId", "request"]) ||
    !isRequestId(value.requestId) ||
    !isRecord(value.request)
  ) {
    return invalid("Unsupported client message");
  }

  const request = value.request;
  if (!hasOnlyKeys(request, ["provider", "prompt", "threadId", "model", "reasoningEffort"])) {
    return invalid("Run request contains unsupported fields");
  }
  if (!isAgentProvider(request.provider)) return invalid("Unknown provider");
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 64_000) {
    return invalid("Prompt must contain between 1 and 64000 characters");
  }
  if (!isOptionalNullableString(request.threadId, 256)) return invalid("Invalid thread id");
  if (!isOptionalString(request.model, 128)) return invalid("Invalid model");
  if (request.reasoningEffort !== undefined && !isReasoningEffort(request.reasoningEffort)) {
    return invalid("Invalid reasoning effort");
  }

  return {
    ok: true,
    value: {
      type: "run",
      requestId: value.requestId,
      request: {
        provider: request.provider,
        prompt: request.prompt,
        threadId: request.threadId,
        model: request.model,
        reasoningEffort: request.reasoningEffort
      }
    }
  };
}

export function parseShellEvent(value: unknown): ParseResult<ShellEvent> {
  if (!isRecord(value) || typeof value.type !== "string") {
    return invalid("Event must be an object with a type");
  }

  if (value.type === "shell.ready") {
    if (
      value.protocolVersion !== SHELL_PROTOCOL_VERSION ||
      !Array.isArray(value.providers) ||
      !value.providers.every(isAgentProvider) ||
      typeof value.workspace !== "string"
    ) {
      return invalid("Invalid shell.ready event");
    }
    return {
      ok: true,
      value: {
        type: value.type,
        protocolVersion: SHELL_PROTOCOL_VERSION,
        providers: value.providers,
        workspace: value.workspace
      }
    };
  }

  if (value.type === "run.started") {
    if (!isRequestId(value.requestId) || !isRunId(value.runId) || !isAgentProvider(value.provider)) {
      return invalid("Invalid run.started event");
    }
    return {
      ok: true,
      value: { type: value.type, requestId: value.requestId, runId: value.runId, provider: value.provider }
    };
  }

  if (value.type === "run.rejected") {
    if (!isRequestId(value.requestId) || value.reason !== "run_in_progress") {
      return invalid("Invalid run.rejected event");
    }
    return { ok: true, value: { type: value.type, requestId: value.requestId, reason: value.reason } };
  }

  if (value.type === "cancel.rejected") {
    if (!isRunId(value.runId) || value.reason !== "run_not_active") {
      return invalid("Invalid cancel.rejected event");
    }
    return { ok: true, value: { type: value.type, runId: value.runId, reason: value.reason } };
  }

  if (value.type === "run.cancelled") {
    if (!isRunId(value.runId)) return invalid("Invalid run.cancelled event");
    return { ok: true, value: { type: value.type, runId: value.runId } };
  }

  if (value.type === "thread.started") {
    if (!isRunId(value.runId) || !isAgentProvider(value.provider) || typeof value.threadId !== "string") {
      return invalid("Invalid thread.started event");
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, provider: value.provider, threadId: value.threadId }
    };
  }

  if (value.type === "turn.started") {
    if (!isRunId(value.runId) || !isAgentProvider(value.provider) || !isOptionalNullableString(value.threadId, 256)) {
      return invalid("Invalid turn.started event");
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, provider: value.provider, threadId: value.threadId }
    };
  }

  if (value.type === "item.started" || value.type === "item.updated" || value.type === "item.completed") {
    if (!isRunId(value.runId) || !isAgentProvider(value.provider) || !isAgentItem(value.item)) {
      return invalid(`Invalid ${value.type} event`);
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, provider: value.provider, item: value.item }
    };
  }

  if (value.type === "agent.delta") {
    if (!isRunId(value.runId) || !isAgentProvider(value.provider) || typeof value.text !== "string") {
      return invalid("Invalid agent.delta event");
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, provider: value.provider, text: value.text }
    };
  }

  if (value.type === "turn.completed") {
    if (
      !isRunId(value.runId) ||
      !isAgentProvider(value.provider) ||
      !isOptionalNullableString(value.threadId, 256) ||
      (value.usage !== undefined && value.usage !== null && !isUsage(value.usage))
    ) {
      return invalid("Invalid turn.completed event");
    }
    return {
      ok: true,
      value: {
        type: value.type,
        runId: value.runId,
        provider: value.provider,
        threadId: value.threadId,
        usage: value.usage
      }
    };
  }

  if (value.type === "turn.failed") {
    if (!isRunId(value.runId) || !isAgentProvider(value.provider) || typeof value.error !== "string") {
      return invalid("Invalid turn.failed event");
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, provider: value.provider, error: value.error }
    };
  }

  if (value.type === "log") {
    if (
      (value.runId !== undefined && !isRunId(value.runId)) ||
      !isLogLevel(value.level) ||
      typeof value.message !== "string"
    ) {
      return invalid("Invalid log event");
    }
    return {
      ok: true,
      value: { type: value.type, runId: value.runId, level: value.level, message: value.message }
    };
  }

  return invalid("Unsupported shell event");
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && agentProviders.has(value as AgentProvider);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && reasoningEfforts.has(value as ReasoningEffort);
}

function isRequestId(value: unknown): value is ShellRequestId {
  return typeof value === "string" && requestIdPattern.test(value);
}

function isRunId(value: unknown): value is ShellRunId {
  return typeof value === "string" && runIdPattern.test(value);
}

function isAgentItem(value: unknown): value is AgentItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    (value.status === undefined || itemStatuses.has(value.status as NonNullable<AgentItem["status"]>)) &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.text === undefined || typeof value.text === "string")
  );
}

function isUsage(value: unknown): value is Usage {
  return (
    isRecord(value) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.cachedInputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.reasoningOutputTokens)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLogLevel(value: unknown): value is "info" | "warn" | "error" {
  return typeof value === "string" && logLevels.has(value as "info" | "warn" | "error");
}

function isOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isOptionalNullableString(value: unknown, maxLength: number): value is string | null | undefined {
  return value === null || isOptionalString(value, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalid<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}
