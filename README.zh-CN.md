[English](README.md) | 简体中文

# Unify Provider

开源、本机运行的 AI 订阅连接器：让编辑器**原生** Chat/Agent 使用你已有的 Codex（ChatGPT 订阅）模型，不再手填 API Key、URL、端口或 JSON。

> 本项目以 [MIT 许可证](LICENSE) 开源。Codex 接入依赖 OpenAI "Sign in with ChatGPT — ChatGPT plan usage" 流程，该流程仅对开源、本地托管的应用开放（见 [docs/risks.md R3](docs/risks.md)），因此项目必须保持开源、不收费、不远程托管。

## 目标与支持策略（方案 A）

| 档位 | 目标 | 体验 | 状态 |
| --- | --- | --- | --- |
| 零配置（MVP） | VS Code（Copilot Chat，Local/Copilot 哈尼斯） | 安装扩展 → 浏览器登录 ChatGPT → 在模型选择器点选一次 Codex 模型 | 进行中 |
| 次级体验（后续） | Qoder 新版桌面应用、Trae | 插件/本地程序启动托管的本地 OpenAI 兼容服务，用户在编辑器设置里手填一次 Base URL / Key / Model ID | 未开始，不在 MVP 内 |
| 不支持，待厂商开放 | Qoder IDE、Cursor | 公开机制下不可行：Qoder IDE 无自定义 Base URL；Cursor 的 BYOK 请求由其服务端发起 | 不投入开发 |

分档依据与证据见 [docs/compatibility.md](docs/compatibility.md)。Qoder 新版应用、Trae 的请求发起侧仍需抓包确认是否为本机，验证前不声明支持。Copilot 哈尼斯需开启实验设置 `chat.agentHost.byokModels.enabled`；Local 与 Copilot 须分别验证。

**Codex 接入路径**：仅使用 OpenAI 官方 Sign in with ChatGPT（SIWC）开源客户端流程——动态注册、PKCE、`127.0.0.1` 回调、`chatgpt.tokens.use.direct` scope，推理直连 `https://api.openai.com/v1/responses`；不复用 Codex CLI client_id、不调用 `chatgpt.com/backend-api`、不依赖 Codex CLI/app-server（比较与合规依据见 [docs/risks.md](docs/risks.md)）。

**Claude**：不接入 Claude Pro/Max 订阅（Anthropic 明确禁止，见 [docs/risks.md R5](docs/risks.md)）。后续若增加 Claude 提供者，仅支持用户自带 API Key / Bedrock / Vertex 等官方允许方式。

## 当前状态

已完成：产品范围固化、可行性与合规调研、核心接口与骨架（提供者契约、注册表、请求路由、编辑器接入契约）。

进行中：core 中的 Codex（SIWC）提供者、VS Code `LanguageModelChatProvider` 扩展。**尚未发布任何可安装插件，VS Code 端到端验证未完成。** 详见 [docs/mvp.md](docs/mvp.md)。

## 目标体验（VS Code）

1. 安装扩展。
2. 点击连接，浏览器打开 ChatGPT 登录并授权。
3. 自动回到编辑器，模型出现在 Chat 模型选择器；点选一次 Codex 模型（VS Code 会记住）。
4. 后续启动自动恢复连接，访问令牌自动续期；额度用尽或授权被撤销时给出明确提示与重新登录入口。

## 开发

开发环境要求 Node.js 22+ 和 npm；最终用户不应需要自行安装开发运行时或执行命令。

```sh
npm install
npm run check
```

## 结构

```text
packages/
  core/                  @unify-provider/core：编辑器无关的核心
    src/core/            提供者契约、注册表、请求路由
    src/editors/         编辑器接入契约与目标清单
    src/providers/       订阅提供者实现（Codex via SIWC，进行中）
    src/transports/      本地兼容接口等传输实现（后续）
    test/
  vscode-extension/      VS Code 扩展：LanguageModelChatProvider 接入（进行中）
  local-endpoint/        插件托管的本地 OpenAI 兼容服务，仅服务次级体验目标（后续，MVP 不实现）
docs/
  architecture.md        架构与三档支持策略
  compatibility.md       编辑器兼容性可行性评估与证据
  mvp.md                 MVP 范围、验收标准与实施清单
  risks.md               合规与平台风险调研（SIWC、Claude 限制、OAuth 安全）
```

文档：[架构](docs/architecture.md) · [兼容性](docs/compatibility.md) · [MVP](docs/mvp.md) · [风险](docs/risks.md)。
