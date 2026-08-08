import { Activity, Bot, Cpu, Play, Square, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  parseShellEvent,
  SHELL_WEBSOCKET_AUTH_PREFIX,
  SHELL_WEBSOCKET_PROTOCOL,
  type AgentProvider,
  type ClientRunRequest,
  type ShellEvent
} from "@netnavr/shell-protocol";

const launchParameters = new URLSearchParams(window.location.hash.slice(1));
const wsUrl =
  import.meta.env.VITE_NETNAVR_SHELL_WS ??
  launchParameters.get("webSocketUrl") ??
  "ws://127.0.0.1:8787/ws";
const sessionToken = import.meta.env.VITE_NETNAVR_SHELL_TOKEN ?? launchParameters.get("sessionToken") ?? "";

type Line = {
  id: string;
  event: ShellEvent;
};

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [providers, setProviders] = useState<AgentProvider[]>(["mock"]);
  const [provider, setProvider] = useState<AgentProvider>("mock");
  const [prompt, setPrompt] = useState("Summarize the current NetNavr Shell and suggest the next implementation step.");
  const [workspace, setWorkspace] = useState("Managed by NetNavr");
  const [model, setModel] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    if (!sessionToken) {
      setLines([
        {
          id: "missing-session-token",
          event: { type: "log", level: "error", message: "Missing local session credentials" }
        }
      ]);
      return;
    }

    const socket = new WebSocket(wsUrl, [
      SHELL_WEBSOCKET_PROTOCOL,
      `${SHELL_WEBSOCKET_AUTH_PREFIX}${sessionToken}`
    ]);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => {
      setConnected(false);
      setRunning(false);
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;

      let rawEvent: unknown;
      try {
        rawEvent = JSON.parse(message.data);
      } catch {
        return;
      }

      const event = parseShellEvent(rawEvent);
      if (event.ok) receive(event.value);
    };

    return () => {
      socket.close();
    };
  }, []);

  const status = useMemo(() => {
    if (running) return "running";
    return connected ? "ready" : "offline";
  }, [connected, running]);

  function receive(event: ShellEvent) {
    if (event.type === "shell.ready") {
      setProviders(event.providers);
      setWorkspace(event.workspace);
      if (event.providers.length > 0) setProvider(event.providers[0]);
      return;
    }

    if (event.type === "thread.started") {
      setThreadId(event.threadId);
    }

    if (event.type === "agent.delta") {
      setStreamText((current) => current + event.text);
    }

    if (event.type === "turn.completed" || event.type === "turn.failed") {
      setRunning(false);
    }

    setLines((current) => [
      ...current,
      {
        id: `${Date.now()}-${current.length}`,
        event
      }
    ]);
  }

  function run() {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    if (!prompt.trim() || prompt.length > 64_000) return;

    setRunning(true);
    setStreamText("");
    setLines([]);

    const request: ClientRunRequest = {
      provider,
      prompt,
      threadId: threadId || undefined,
      model: model.trim() || undefined,
      reasoningEffort: "medium"
    };

    socketRef.current.send(JSON.stringify({ type: "run", request }));
  }

  function cancel() {
    socketRef.current?.send(JSON.stringify({ type: "cancel" }));
    setRunning(false);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <Terminal size={19} aria-hidden="true" />
          <span>NetNavr Shell</span>
        </div>
        <div className={`status ${status}`}>
          <Activity size={15} aria-hidden="true" />
          <span>{status}</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="leftpane">
          <label>
            <span>Provider</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as AgentProvider)}>
              {providers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="default" />
          </label>

          <label>
            <span>Managed Workspace</span>
            <input value={workspace} readOnly aria-readonly="true" />
          </label>

          <div className="threadbox">
            <Bot size={16} aria-hidden="true" />
            <span>{threadId ?? "new thread"}</span>
          </div>
        </aside>

        <section className="mainpane">
          <div className="composer">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="actions">
              <button type="button" onClick={run} disabled={!connected || running} title="Run">
                <Play size={17} aria-hidden="true" />
                <span>Run</span>
              </button>
              <button type="button" onClick={cancel} disabled={!running} title="Cancel">
                <Square size={16} aria-hidden="true" />
                <span>Stop</span>
              </button>
            </div>
          </div>

          <div className="output">
            <div className="output-head">
              <Cpu size={16} aria-hidden="true" />
              <span>Agent Output</span>
            </div>
            <pre>{streamText || "Waiting for a run."}</pre>
          </div>
        </section>

        <aside className="rightpane">
          <div className="event-title">Events</div>
          <div className="events">
            {lines.map(({ id, event }) => (
              <EventRow key={id} event={event} />
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function EventRow({ event }: { event: ShellEvent }) {
  const label = event.type;
  let detail = "";

  if ("message" in event) detail = event.message;
  if ("item" in event) detail = event.item.title ?? event.item.type;
  if (event.type === "thread.started") detail = event.threadId;
  if (event.type === "turn.failed") detail = event.error;
  if (event.type === "turn.completed") detail = event.usage ? `${event.usage.inputTokens} in / ${event.usage.outputTokens} out` : "done";

  return (
    <div className="event-row">
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}
