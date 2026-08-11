# NetNavr

> A local-first personal network navigator designed to stay yours across
> models and devices.

[English](#english) · [简体中文](#简体中文)

**Pre-alpha / Public Lab.** NetNavr is an early, runnable research prototype.
It is not ready for ordinary users, important data, production payments, or
untrusted networks. Features described as goals are not implemented unless the
current code and tests demonstrate them.

<a id="english"></a>

## English

### What is NetNavr?

NetNavr is building a user-controlled layer for personal AI continuity: your
identity, governed memory, permissions, and installed abilities should remain
portable while models, providers, devices, and interfaces can be replaced.

It is intended to become a **personal network navigator**, not another chat UI,
an unrestricted agent runner, or a wrapper around one model provider.

### What works today

| Area | Responsibility | Verifiable implementation |
| --- | --- | --- |
| `core/` | Shared runtime, durable state, identity, governed data, permissions, and ability contracts | Loopback-only daemon; SQLite schema migration v1; persistent Node identity; read-only health and Node endpoints |
| `shell/` | Replaceable human interaction surfaces | Electron/React/TypeScript shell; local server; mock provider and Codex provider integration |
| `pay/` | Payment-specific behavior kept outside the general runtime | Sandbox SQLite order ledger; idempotent order creation; signed webhook tests |

The current Core creates one stable, non-secret **Node ID** for a local
installation and stores it in SQLite. The ID survives process restarts and can
be inspected through `GET /v1/node`. Storage initialization fails closed when a
database is corrupt, has inconsistent migration history, or uses a newer schema
than this Core understands. A missing or invalid stored Node identity is also
rejected instead of being silently replaced.

A Node ID is not a user identity or an authentication credential. **Navigator
identity, governed memory, permission enforcement, provider-switching
continuity, pairing, and backup/restore are not complete yet.**

### Run and verify locally

Requirements:

- Node.js 24 or newer
- npm

Install the Shell dependencies and run every current repository check:

```bash
npm --prefix shell ci
npm run verify
```

Start Core:

```bash
npm run dev:core
```

Core listens on `127.0.0.1:8786` by default. In another terminal:

```bash
curl http://127.0.0.1:8786/v1/health
curl http://127.0.0.1:8786/v1/node
```

Its default database is `~/.netnavr/core/core.sqlite`. To use an isolated data
directory:

```bash
NETNAVR_CORE_DATA_DIR=/absolute/path/to/data npm run dev:core
```

Node.js 24 may print an `ExperimentalWarning` for its built-in `node:sqlite`
module. That warning is expected in this pre-alpha prototype.

Start the browser Shell in another terminal:

```bash
npm --prefix shell run dev
```

The payment sandbox defaults to the same development port as the Shell. If both
must run at once, give Pay a different loopback port:

```bash
NETNAVR_PAY_PORT=8788 npm --prefix pay start
```

These development endpoints do not yet have a complete application-level
authentication and permission system. Do not expose them to the public internet.

### The first product proof

The first meaningful proof is continuity, not feature count:

1. Create a Navigator identity on a user-controlled Node.
2. Save governed memory with provenance and an explicit confirmation state.
3. Invoke one low-risk ability through a clear permission boundary.
4. Switch intelligence providers without losing identity or confirmed memory.
5. Back up and restore the same state in an isolated environment.

The persistent Node identity now establishes the storage and installation anchor
for that proof. It does not complete the proof by itself.

### Abilities

NetNavr uses **Ability** as the umbrella term for an installable capability. An
Ability package may contain one or more building blocks:

- **Tool** — one bounded operation the runtime can invoke.
- **Connector** — authenticated access to an external system or data source.
- **Skill** — instructions and workflow knowledge for using capabilities.
- **Plugin** — an installable package that may combine tools, connectors,
  skills, UI, storage, and lifecycle hooks under a permission manifest.

The public Ability manifest, sandbox, permission contract, signing model, and
third-party compatibility promise are still being designed. Core must retain
secrets and policy authority; installed code should receive only restricted
handles granted by the user.

### Contributing and security

NetNavr is looking first for reproducible failure reports, focused experiments,
and critique of its ownership and portability model. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a change.

Do not report vulnerabilities in a public issue. See
[SECURITY.md](SECURITY.md) for the private reporting path and current safety
limits.

Licensed under the Apache License 2.0. See [LICENSE](LICENSE).

---

<a id="简体中文"></a>

## 简体中文

### NetNavr 是什么？

NetNavr 正在构建一个由用户掌控的个人 AI 连续性底座：身份、受治理的记忆、
权限与已安装能力应当能够持续保留，而模型、服务商、设备和交互界面都可以替换。

它的目标是成为一个**个人网络领航员**，而不是又一个聊天界面、无限制 Agent
执行器，或某一家模型服务商的套壳应用。

### 今天已经能运行什么

| 区域 | 责任 | 可验证实现 |
| --- | --- | --- |
| `core/` | 共享运行时、持久状态、身份、受治理数据、权限与能力契约 | 仅监听本机回环地址的服务；SQLite v1 迁移；持久 Node 身份；只读健康与 Node 接口 |
| `shell/` | 可替换的人机交互界面 | Electron/React/TypeScript Shell；本地服务；Mock Provider 与 Codex Provider 接入 |
| `pay/` | 与通用运行时隔离的支付专属行为 | SQLite 沙盒订单账本；幂等创建订单；签名 Webhook 测试 |

当前 Core 会为一次本地安装创建一个稳定、且不作为秘密使用的 **Node ID**，并保存在
SQLite 中。它在进程重启后保持不变，可通过 `GET /v1/node` 读取。当数据库损坏、
迁移记录不一致，或数据库版本高于当前 Core 可理解的版本时，启动会明确失败，
不会静默覆盖或降级数据。已保存的 Node 身份如果缺失或格式无效，也会拒绝启动，
而不是悄悄换成一个新身份。

Node ID 不是用户身份，也不是认证凭据。**Navigator 身份、受治理记忆、权限执行、
切换模型服务商后的连续性、设备配对和备份恢复，目前都尚未完成。**

### 本地运行与验证

环境要求：

- Node.js 24 或更高版本
- npm

安装 Shell 依赖并运行仓库当前全部检查：

```bash
npm --prefix shell ci
npm run verify
```

启动 Core：

```bash
npm run dev:core
```

Core 默认只监听 `127.0.0.1:8786`。另开一个终端即可核对：

```bash
curl http://127.0.0.1:8786/v1/health
curl http://127.0.0.1:8786/v1/node
```

默认数据库路径是 `~/.netnavr/core/core.sqlite`。如需隔离数据目录：

```bash
NETNAVR_CORE_DATA_DIR=/绝对路径/到/数据目录 npm run dev:core
```

Node.js 24 可能会为内置的 `node:sqlite` 模块显示 `ExperimentalWarning`；在当前
Pre-alpha 原型中，这是预期提示。

另开一个终端启动浏览器 Shell：

```bash
npm --prefix shell run dev
```

Pay 沙盒默认与 Shell 使用同一个开发端口。如需同时运行，请给 Pay 指定另一个
回环端口：

```bash
NETNAVR_PAY_PORT=8788 npm --prefix pay start
```

这些开发接口尚未具备完整的应用级认证与权限系统，请勿将其暴露到公网。

### 第一阶段要证明什么

NetNavr 的第一个有效产品证明是“连续性”，而不是功能数量：

1. 在用户掌控的 Node 上创建 Navigator 身份；
2. 保存带来源、带明确确认状态的受治理记忆；
3. 通过清晰的权限边界调用一个低风险 Ability；
4. 更换智能服务商后，身份与已确认记忆仍然连续；
5. 在隔离环境中完成同一份状态的备份与恢复。

这次实现的持久 Node 身份，为上述证明建立了存储与安装锚点，但它本身并不代表
整个证明已经完成。

### Ability 能力体系

NetNavr 使用 **Ability（能力）** 作为“可安装能力”的总称。一个 Ability 包可以
包含下列一个或多个构件：

- **Tool（工具）**：运行时可以调用的一项边界明确的操作；
- **Connector（连接器）**：对外部系统或数据源的鉴权访问；
- **Skill（技能）**：指导如何使用能力的说明与工作流知识；
- **Plugin（插件）**：一种可安装的软件包，可以在权限清单约束下组合 Tool、
  Connector、Skill、界面、存储和生命周期钩子。

公开 Ability 清单、沙盒、权限契约、签名机制和第三方兼容承诺仍在设计中。Core
必须保留秘密信息与策略裁决权；安装代码只能获得用户明确授予的受限句柄。

### 参与贡献与安全

NetNavr 现阶段最需要的是可复现的失败报告、小而聚焦的实验，以及对“用户所有权
与可迁移性”模型的批评与建议。提交修改前请先阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

请勿在公开 Issue 中报告安全漏洞。私密报告方式与当前安全边界见
[SECURITY.md](SECURITY.md)。

项目采用 Apache License 2.0，详见 [LICENSE](LICENSE)。
