# NetNavr

> A local-first personal network navigator designed to stay yours across
> models and devices.

NetNavr explores a simple idea: a person's durable AI identity, governed
memory, permissions, and abilities should live on infrastructure they control,
while intelligence providers remain replaceable.

## Status

**Pre-alpha / Public Lab.** This repository is an early, runnable research
prototype. It is not ready for ordinary users, important data, production
payments, or untrusted networks. The long-term product promises described below
are design goals unless the current implementation and tests prove otherwise.

## Current prototype

| Area | Responsibility | What exists today |
| --- | --- | --- |
| `core/` | Shared runtime, identity, governed data, permissions, and ability contracts | A minimal loopback-only daemon and health contract |
| `shell/` | Human interaction through web and macOS surfaces | Electron/React/TypeScript shell, local server, mock provider, and Codex provider integration |
| `pay/` | Payment-specific behavior isolated from the general runtime | A sandbox SQLite vertical slice with an order ledger, idempotent creation, and signed webhook tests |

Core owns durable state and shared policy. Shell is a replaceable interaction
surface. Pay is a high-risk, separately bounded module and is not part of the
first product proof.

## What NetNavr is trying to prove

The first meaningful proof is continuity, not another chat window:

1. Create a Navigator identity on a user-controlled Node.
2. Save a memory with provenance and explicit governance.
3. Use one low-risk ability with clear permissions and structured results.
4. Switch intelligence providers without losing identity or confirmed memory.
5. Back up and restore that state in an isolated environment.

Navigator identity, governed memory, a public ability contract, provider
switching continuity, and backup/restore are not complete yet.

## Run locally

Requirements:

- Node.js 24 or newer
- npm

Install the Shell dependencies and run all current checks:

```bash
npm --prefix shell ci
npm run verify
```

Start the Core daemon:

```bash
npm run dev:core
```

Start the browser Shell in another terminal:

```bash
npm --prefix shell run dev
```

The payment sandbox defaults to the same development port as the Shell. If you
need both at once, assign Pay a different loopback port:

```bash
NETNAVR_PAY_PORT=8788 npm --prefix pay start
```

Do not expose these development services to the public internet.

## Architecture direction

NetNavr calls installable capabilities **Abilities**. An Ability package may
contain one or more of these building blocks:

- **Tool** — a bounded operation the runtime can invoke.
- **Connector** — authenticated access to an external system or data source.
- **Skill** — instructions and workflow knowledge that guide how capabilities
  are used.
- **Plugin** — an installable package that can combine tools, connectors,
  skills, UI, storage, and lifecycle hooks under a permission manifest.

The runtime contract, permission model, lifecycle, and safety boundaries are
still being designed. No third-party compatibility promise is made yet.

## Contributing and security

NetNavr is looking first for reproducible failure reports, small experiments,
and critique of the ownership and portability model. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a change.

Please do not report vulnerabilities in a public issue. See
[SECURITY.md](SECURITY.md) for the private reporting path and current safety
limits.

## License

Apache License 2.0. See [LICENSE](LICENSE).
