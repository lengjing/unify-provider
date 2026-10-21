# 合规与平台风险调研

调研日期：2026-10-20。本文只记录能够核对到原文的结论；找不到来源的地方明确标注"未找到明确来源"。所有引用原文均为英文原文摘录，中文为说明。

## 0. 关键发现（先读这一段）

1. **OpenAI 已经提供面向开源/本地客户端的官方订阅接入通道：Sign in with ChatGPT（SIWC）"ChatGPT plan usage" 流程。** 它通过 `client_id=dynamic_agent_client` 动态注册、PKCE + loopback 回调、`chatgpt.tokens.use.direct` scope，用官方公开的 `https://api.openai.com/v1/responses` 做推理，不需要 client secret，也不需要复用 Codex CLI 的 client_id。OpenAI 文档明确写道 "do not point it at ChatGPT's `backend-api` endpoints"。
2. **OpenCode 本身已经从"复用 Codex client_id + `chatgpt.com/backend-api/codex/responses`"迁移到 SIWC**（dev 分支 `packages/core/src/plugin/provider/chatgpt.ts` 使用 `dynamic_agent_client`、`ext_agent_host_id`、`resource=https://api.openai.com/v1`），并被 OpenAI 用户文档列为 "Open-source integrations" 之一。任务说明中引用的 v1.2.27 `codex.ts` 做法是**旧路径**。
3. **OpenAI 对旧路径的公开表态**（Codex app-server 文档 "Auth endpoints" 小节）："App-server authentication has never been permitted for commercial or hosted services." 对本地/开源应用则是 "you can continue using it, though we recommend migrating to Sign in with ChatGPT"。
4. **Anthropic 明确禁止第三方应用使用 Claude Pro/Max 订阅凭证**，且声明 "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice"。Claude Code 路线图应从"订阅接入"中删除，只保留"用户自带 API key / 云厂商凭证"这一官方允许方式。
5. 编辑器厂商（Cursor、Qoder、Trae、VS Code）均**官方提供** BYOK / 自定义模型 / 自定义 Base URL 入口；已检索到的条款中没有禁止用户配置自己的模型提供者的条文。风险主要在于 BYOK 的功能限制与企业策略开关，而非条款禁止。

## 1. 风险总表

| # | 风险 | 严重度 | 证据（摘要，详见各小节与来源列表） | 缓解 / 决策建议 |
|---|------|--------|------|------|
| R1 | 复用 Codex CLI 的 OAuth `client_id`（`app_EMoamEEZ73f0CkXaXp7hrann`）并把请求改写到 `chatgpt.com/backend-api/codex/responses` | **高** | OpenAI：app-server 认证 "has never been permitted for commercial or hosted services"；SIWC 文档 "do not point it at ChatGPT's `backend-api` endpoints"；OpenAI ToU 禁止 "reverse engineer... underlying components" 与 "circumvent any rate limits or restrictions"；OpenCode 自身已弃用该路径 | **不采用。** 改用 SIWC（R3）。如果未来任何实验性代码碰到该路径，只能用于本地开发验证，不得进入发布包 |
| R2 | 把 Codex app-server 当作"模型端点"接入编辑器原生 Agent | **中高**（架构不匹配） | app-server 是 Codex 自己的 Agent 运行时（线程/回合/审批/工具执行都在 Codex 内），不是裸模型推理 API；WebSocket 传输 "experimental and unsupported"；需随包分发 Codex CLI 二进制（`@openai/codex` 0.163.0，Apache-2.0，按平台拆分 optionalDependencies） | 不作为 MVP 的推理通道。只在"编辑器原生 Agent 无法接自定义模型、必须托管一个独立 Agent"时再评估 |
| R3 | SIWC OSS 流程仍是 **preview**，有一组 Responses API 字段/工具限制；资格仅覆盖"open-source and locally hosted apps"，付费或远程托管产品要走 partner 名单 | **中** | SIWC "Preview limitations"：必须 `store:false`、`stream:true`，禁止 `temperature`/`max_output_tokens`/`previous_response_id` 等；不支持 hosted tools；"If you're interested in offering it in a paid or remotely hosted app, complete the interest form" | **采用，并把限制固化到协议转换层**（剔除不支持字段、把系统消息改为 `instructions`/developer）。项目保持开源、本地运行、免费；`agent_name_hint`/`clientInfo.name` 用稳定的真实产品名；若未来收费需先申请 partner |
| R4 | 用户额度被我们的产品消耗、触发 429/403 后体验差；用户可在 ChatGPT 设置里单独限制或断开本应用 | 中 | SIWC：Plus 用户的 5 小时限额跨所有应用共享；`subscription_sharing_usage_limit_exceeded`(429)、`subscription_sharing_user_not_eligible`(403)；"OpenAI does not currently notify your tool when a user disconnects the app" | 按 SIWC UI/UX 指南：首次登录显示"You're using your ChatGPT plan"确认、显示 "Using ChatGPT plan"、"Manage usage" 链接到 `chatgpt.com/settings/usage`；限额时不要重试、不要循环 OAuth |
| R5 | 通过 Claude Pro/Max 订阅给第三方应用（包括本插件）提供模型 | **极高** | Anthropic Claude Code Legal：OAuth "intended exclusively for... native Anthropic applications"；"Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users"；"developers may not collect, store, or intermediate Claude.ai credentials or session tokens"；Agent SDK 文档同样禁止 | **路线图删除"Claude 订阅接入"**。Claude 提供者只允许用户自带 Anthropic API key / Bedrock / Vertex / Foundry 凭证（这是 Anthropic 明确允许的） |
| R6 | 编辑器厂商条款禁止修改模型配置或绕过计费 | 低 | Cursor、Qoder、Trae、VS Code 都在官方文档提供 BYOK/自定义模型入口；Cursor ToS 禁止的是逆向、修改服务、模型抽取等，不涉及用户配置自己的模型；Trae ToS 全文未能抓取 | 只走各编辑器**文档化的** BYOK/自定义模型/Language Model Provider 入口，不改编辑器二进制、不绕过其付费功能（如 Cursor Tab）。Trae ToS 待人工核对 |
| R7 | 本地 OAuth 回调绑定固定端口（1455）；共享机器上的 refresh token 泄露 | 中 | Codex CLI 自身也用 `localhost:1455`，会端口冲突；SIWC 要求 `127.0.0.1` loopback，端口可变；refresh token 有效 30 天且轮换；文件存储要求 `0600` | 使用临时端口 + `state` + PKCE + `nonce`；token 放宿主 SecretStorage；登出时调用 revocation endpoint；提示共享账户风险 |
| R8 | 平台随时变更（预览 API、模型目录、客户端名单、条款） | 中 | OpenAI ToU："All other changes will be effective as soon as we post them"；SIWC 处于 preview；Codex app-server 多个方法标注 experimental | 在 UI 和 README 明确告知；模型目录从 `GET /v1/models` 动态获取；把"接口变更导致不可用"作为预期故障处理，给出"重新登录 / 改用 API key"退路 |

## 2. 风险详细说明

### 2.1 Codex：三条可能路径的事实核对

#### 路径 A：复用 Codex CLI 的 client_id + `chatgpt.com/backend-api/codex/responses`

事实（来源：OpenCode v1.2.27 `packages/opencode/src/plugin/codex.ts`）：

- `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`，`ISSUER = "https://auth.openai.com"`，`CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"`，`OAUTH_PORT = 1455`。
- authorize 请求带 `codex_cli_simplified_flow: "true"`、`originator: "opencode"`；请求阶段把 `/v1/responses` 或 `/chat/completions` 改写到 backend-api，并加 `ChatGPT-Account-Id` 头。
- 另有 "headless" 分支直接调用 `auth.openai.com/api/accounts/deviceauth/usercode`（Codex 的设备码接口）。

条款与官方表态：

- OpenAI Terms of Use（ROW 版本，Effective January 1, 2026）"What you cannot do" 列表原文：
  - "Attempt to or assist anyone to reverse engineer, decompile or discover the source code or underlying components of our Services, including our models, algorithms, or systems (except to the extent this restriction is prohibited by applicable law)."
  - "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services."
  - "You may not share your account credentials or make your account available to anyone else..."
  - 条款没有逐字提到"第三方客户端"或"复用 client_id"，但 backend-api 是未公开接口，复用他人 OAuth 客户端标识属于绕过客户端注册/限制的灰色行为。
- OpenAI Codex app-server 文档 "Auth endpoints" 原文："If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT so users have greater control over and visibility into their usage. ... **App-server authentication has never been permitted for commercial or hosted services.** We launched Sign in with ChatGPT to support these use cases..."
- SIWC "Models and inference" 原文："**Supported endpoint:** Use the public Responses API endpoint above for this ChatGPT plan usage flow; **do not point it at ChatGPT's `backend-api` endpoints.**"
- OpenAI Usage Policies 页面抓取返回 HTTP 403，**未能核对原文**。

结论：路径 A 是 OpenAI 明确不鼓励、且已有官方替代的做法；对"面向大众分发"的产品尤其不合适。OpenCode 自己也已经切换到路径 C（见 2.1.3）。

#### 路径 B：官方 Codex app-server

事实（来源：`https://developers.openai.com/codex/app-server/`，现重定向至 `learn.chatgpt.com/docs/app-server`）：

- 定位："Codex app-server is the interface Codex uses to power rich clients (for example, the Codex VS Code extension). Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events."——它**是官方认可的第三方集成面**，但集成对象是 **Codex 这个 Agent**，不是裸模型。
- 能否用 ChatGPT 登录：可以。认证模式包括 `apikey`、`chatgpt`（Codex 自己管理 OAuth 与刷新，浏览器流或设备码流）、`chatgptAuthTokens`（experimental，宿主自己持有 token 并在 `account/chatgptAuthTokens/refresh` 时刷新）。
- 对调用方的要求："Use `clientInfo.name` to identify your client for the OpenAI Compliance Logs Platform. If you are developing a new Codex integration intended for enterprise use, please contact OpenAI to get it added to a known clients list."
- 传输：stdio（默认，JSONL）、WebSocket（"experimental and unsupported"）、Unix socket。"The app-server command and WebSocket transport are experimental and aren't supported for production workloads."
- 需要的 CLI 与分发：app-server 是 Codex CLI 的子命令，需要随插件分发 Codex CLI。npm `@openai/codex` 最新 0.163.0，许可 Apache-2.0，按 `@openai/codex-{linux,win32,darwin}-{x64,arm64}` 六个平台包分发。Schema 与版本绑定："Each output is specific to the Codex version you ran"。
- 与 SIWC 组合：SIWC 文档提供 "Codex app-server" 配置（`model_provider="openai_chatgpt_plan"`，`base_url="https://api.openai.com/v1"`，`env_key="ACCESS_TOKEN"`，`wire_api="responses"`），由宿主负责刷新 token 并重启 app-server。

对本项目的关键判断：项目要求"编辑器**原生** Agent 使用订阅模型"，编辑器原生 Agent 自己跑工具循环，需要的是**模型推理端点**（OpenAI-compatible / Anthropic-compatible / Responses）。app-server 暴露的是 `thread/start`、`turn/start`、`item/*` 这类 Agent 级协议，工具由 Codex 执行；若硬塞给编辑器原生 Agent，会变成"Agent 套 Agent"，而且无法满足 AGENTS.md 中"Native agent integration is required. A separate chat panel is not equivalent."。因此路径 B 不是 MVP 的推理通道。

#### 路径 C：Sign in with ChatGPT —— ChatGPT plan usage（开源/本地客户端）

事实（来源：`https://developers.openai.com/siwc/token-sharing-open-source*`）：

- 资格："These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." Quickstart："ChatGPT plan usage is available to all open-source partners and selected private clients."
- 注册与登录：首次 `client_id=dynamic_agent_client` + `agent_name_hint=<你的真实产品名>` + `ext_agent_host_id=<稳定的主机标识>`；回调返回 issued `client_id`（`oaiapp_...`），之后复用。authorize 端点 `https://auth.openai.com/api/accounts/authorize`，token 端点 `https://auth.openai.com/api/accounts/oauth/token`，`resource=https://api.openai.com/v1`，scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`。"This direct flow needs neither a client secret nor a partner API key."
- 回调要求：`http://127.0.0.1:<port>/auth/callback`，"only the port may vary"，"Do not substitute with `localhost`"。
- 推理：`POST https://api.openai.com/v1/responses`，`Authorization: Bearer <access_token>`，必须 `store:false`、`stream:true`。模型列表 `GET https://api.openai.com/v1/models`（按 `visibility == "list"` 过滤）。
- 令牌：access token 1 小时；refresh token 30 天、每次刷新轮换；登出用 `revocation_endpoint`。
- 预览限制（必须在协议转换层处理）：禁止 `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user`；不允许 `previous_response_id`（历史要放进 `input`）；显式 `{type:"message", role:"system"}` 被拒绝，需改用 `instructions`/developer；支持 function/custom tools（"Group function/custom tools in namespaces or supply them through `additional_tools`"）；不支持 image generation、file search、Code Interpreter、computer use、hosted MCP、`tool_search`。
- 错误码：`subscription_sharing_user_not_eligible`(403)、`subscription_sharing_usage_limit_exceeded`(429)、`subscription_sharing_usage_unavailable`(503)、`subscription_sharing_unsupported_capability`(400)、`subscription_sharing_route_not_supported`(403) 等。"OpenAI does not silently switch the request to another billing path."
- 用户侧控制：用户可在 ChatGPT Settings → Usage 为每个应用设置周限额百分比、是否允许使用额度；可在 Security and login → Sign in with ChatGPT 断开应用。Plus 用户的 5 小时限额跨所有应用共享。
- 现网采用者（OpenAI 用户文档 "Open-source integrations"）：OpenClaw、OpenCode、Pi、T3。

结论：路径 C 是目前唯一既有官方文档、又与"编辑器原生 Agent 需要裸模型端点"匹配的方案。**建议 MVP 采用路径 C。**

#### OpenCode 现状核对

- OpenCode dev 分支 `packages/core/src/plugin/provider/chatgpt.ts`（已核对原文）：`const registrationClientID = "dynamic_agent_client"`、`const agentName = "OpenCode"`、`const tokenURL = \`${issuer}/api/accounts/oauth/token\``、`const resource = "https://api.openai.com/v1"`、`const tokenSharingScope = "chatgpt.tokens.use.direct"`；authorize URL 带 `ext_agent_host_id`、`nonce`、`resource`。**没有** `app_EMoamEEZ73f0CkXaXp7hrann`、没有 `backend-api`。
- 即 OpenCode 已从路径 A 迁移到路径 C。任务说明中引用的 v1.2.27 代码不应作为实现参考。

#### OpenCode 文档引用（注意：这是 OpenCode 的说法，不是 OpenAI 的授权）

`https://opencode.ai/docs/providers/#anthropic` 原文：

> "Other companies support freedom of choice with developer tooling - you can use the following subscriptions in OpenCode with zero setup:
> - ChatGPT Plus
> - Github Copilot
> - Gitlab Duo"

同页 OpenAI 小节原文："We recommend signing up for ChatGPT Plus or Pro. ... Here you can select the **ChatGPT Plus/Pro** option and it'll open your browser and ask you to authenticate."

这段话是 OpenCode 项目的产品描述，**不构成 OpenAI 对任何第三方的授权**。OpenAI 方面可引用的依据是 SIWC 文档与 learn.chatgpt.com 把 OpenCode 列为 "Open-source integrations"。

### 2.2 Claude 订阅（Pro / Max）第三方使用限制

OpenCode 文档 `https://opencode.ai/docs/providers/#anthropic` 原文：

> "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this.
> Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0"

Anthropic 官方条款原文：

- Claude Code "Legal and compliance" → "Authentication and credential use"：
  - "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. **Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.** Moreover, **developers may not collect, store, or intermediate Claude.ai credentials or session tokens** — sign-in to a Claude account must complete through Anthropic's own flow."
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
  - 允许的例外："This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials ... Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription..."
- 同页 "Can customers offer Claude Code in their products?"："The Claude Code binary must not be modified. ... customers may not remove, disable, or restrict any authentication method built into it"；"Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf."
- Claude Agent SDK Overview："Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
- Consumer Terms of Service（Effective October 8, 2025）："You may not share your Account login information, Anthropic API key, or Account credentials with anyone else."；"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." 属禁止行为。
- Usage Policy（页面显示 Effective November 12, 2026）："Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products, including by circumvention of the account sign-up or log-in process ... without prior authorization from Anthropic" 属禁止行为。

官方认可的第三方途径：

- Agent SDK + API key（Console 计费）。
- Claude Code 的官方 IDE 集成（VS Code、JetBrains 扩展）与 Desktop——这些是 Anthropic 自己的客户端，由用户在其中用自己的订阅登录，不是第三方可复用的接口。
- 未修改的 Claude Code 二进制可被平台"预装/运行"，但每个终端用户必须自己登录，平台不得中介凭证。
- 未发现 Anthropic 提供类似 OpenAI SIWC 的"第三方应用使用订阅额度"的 OAuth 程序。

### 2.3 编辑器厂商条款与入口

| 编辑器 | 条款中是否禁止修改模型配置/绕过计费 | 官方 BYOK / 自定义模型入口 | 备注 |
|---|---|---|---|
| Cursor | Terms of Service（Last updated September 3, 2026）1.5 节禁止的是逆向工程、修改/派生服务、模型抽取、探测渗透、抓取等；未见禁止用户配置自己模型的条文 | 官方文档 "Bring your own API key"：Settings → Models 配置 OpenAI / Anthropic / Google / Azure / AWS Bedrock 的 key，"Your provider ... bills you directly"；"Custom API keys only work with chat models. Tab completion continues using Cursor's built-in models."；OpenAI 项注明 "Standard, non-reasoning chat models" | 当前 BYOK 文档未提到自定义 Base URL；Teams/Enterprise 下 "Cursor Token Rate still applies"。能否把 Responses 风格模型接入需在兼容性验证中确认 |
| Qoder | 未找到可公开抓取的 Terms of Service 页面（`/terms`、`/terms-of-service`、`/legal/terms-of-service`、`/user-agreement` 均 404） | 官方文档 "Custom models"："Qoder supports accessing third-party provider model resources via API keys."；"Custom providers: OpenAI Compatible and Anthropic Compatible"；支持自定义 Base URL（Chat Completions / Responses） | Pricing 页列出 Free 计划包含 "Bring Your Own Key (BYOK)" |
| Trae | `https://www.trae.ai/terms-of-service` 为纯前端渲染，**条款全文未能抓取** | 官方文档 "Built-in models & custom models"：可添加自定义模型，Provider 支持 OpenAI-compatible（"Common compatible services include OpenAI, DeepSeek, OpenRouter, some Ollama/OpenAI-compatible proxies"）与 Anthropic Messages（可关闭预设并填写 base URL） | 条款需人工在浏览器中核对 |
| VS Code | — | 官方文档 "Language models"：Custom Endpoint provider 支持 Chat Completions / Responses / Anthropic Messages；扩展可通过 Language Model Provider API 注册模型 | "If you are a Copilot Business or Enterprise user, your administrator can disable the Bring Your Own Language Model Key in VS Code policy" |

结论：R6 风险低；合规要点是**只用文档化入口**，不改二进制、不替换编辑器自带付费功能（如 Cursor Tab）。

### 2.4 本地 OAuth 回调与凭证存储安全

- 固定端口（如 1455）的问题：Codex CLI 自身的回调也是 `localhost:1455`（Codex 认证文档："tunneling Codex's local callback server (default `localhost:1455`)"），插件与 CLI 同时登录会冲突；任何本地进程都能抢先监听该端口接收回调。SIWC 允许端口变化（"only the port may vary"），应使用临时端口。
- 缓解：loopback 仅绑定 `127.0.0.1`；每次登录生成新的 `state`、`nonce`、PKCE verifier 并严格校验；回调页不回显 code；收到非法 `state` 立即拒绝；5 分钟超时；登录中显示"请勿在共享浏览器中操作"的提示。
- refresh token：有效 30 天且轮换；"serialize refreshes for the same session so two processes do not race a rotating token"。存储用宿主 SecretStorage（VS Code 系列映射到 OS 凭据库）；退回文件时 `0600`/用户专属目录、原子写入；绝不写日志/遥测。登出时调用 revocation endpoint 并清本地；告诉用户可在 ChatGPT 设置中断开。
- 共享机器：同一 OS 账户下的其他人可读取 SecretStorage；在 UI 提示"共享电脑请用完即登出"。`ext_agent_host_id` 不是凭证，但也不要用邮箱等可识别信息生成。

## 3. Codex 接入路径对比

任务要求比较"复用 client_id"与"app-server"两条路径；因调研发现官方 SIWC 路径，补充为三列。

| 维度 | A. 复用 Codex client_id + backend-api | B. Codex app-server（Codex 管理登录 或 chatgptAuthTokens） | C. Sign in with ChatGPT（OSS plan usage，直连 `api.openai.com/v1/responses`） |
|---|---|---|---|
| 合规性 | 差。未公开接口 + 借用他人 client_id；OpenAI 称 app-server 认证 "never been permitted for commercial or hosted services"，SIWC 文档要求不要打 backend-api | 可。官方第三方集成面；对本地/开源应用"可以继续用，建议迁移到 SIWC"；企业用途需加入 known clients 名单 | 好。专为 "open-source and locally hosted apps" 设计，无需 secret/partner key；付费或托管产品需走 partner 名单 |
| 被封堵风险 | 高。随时可因 originator/client_id/backend-api 变更失效，且无申诉渠道 | 中。协议随 Codex 版本演进；WebSocket "experimental and unsupported"；多方法标注 experimental | 中低。处于 preview，错误码与字段限制可能变化，但有正式文档、错误码与用户侧控制面板 |
| 部署复杂度 | 低（纯 HTTP） | 高。需随插件分发 6 个平台的 Codex CLI 二进制并跟版本、管理子进程、token 刷新后需重启 app-server 并 `thread/resume` | 低（纯 HTTP + loopback 回调）。需实现动态注册、ID token 校验（JWKS）、scope 检查 |
| 工具调用支持 | 由 backend-api 决定，无文档 | 工具由 Codex 执行（shell/文件/MCP/审批），编辑器原生 Agent 无法接管；`dynamicTools` 为 experimental | 支持 function/custom tools（需 namespace 或 `additional_tools`），编辑器原生 Agent 自己执行；不支持 hosted tools |
| 与"编辑器原生 Agent"目标匹配度 | 匹配（裸模型端点），但不合规 | 不匹配（Agent 套 Agent，另起面板） | 匹配 |
| 认证恢复 | 依赖 Codex 的 refresh；账号/设备码接口非公开 | Codex 自动刷新并持久化到 `~/.codex/auth.json` 或 keyring；`chatgptAuthTokens` 模式由宿主刷新 | access 1h / refresh 30d 轮换；标准 OAuth refresh；`invalid_grant` 等错误码明确；revocation endpoint；用户可在 ChatGPT 设置断开（无主动通知） |
| 额度与用户可见性 | 与 Codex 共享，用户看不到应用级用量 | 与 Codex 共享，可通过 `account/rateLimits/read` 读取 | 用户可按应用设置周限额、查看应用用量；错误码区分"计划用尽"与"应用限额" |
| 结论 | **不采用** | 备选：仅当需要托管独立 Codex Agent 时 | **MVP 采用** |

## 4. Claude Code 路线图建议

决策：**删除"Claude Pro/Max 订阅接入"**；Claude 提供者改为"仅限官方允许方式"。

- 不实现、不捆绑、不推荐任何读取 Claude Code OAuth token、复用 claude.ai 登录、或模拟 Claude Code 客户端的方案。Anthropic 原文："does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users"，并保留无通知执法权。OpenCode 已在 1.3.0 移除同类插件。
- 允许保留的 Claude 提供者形态：用户自带 Anthropic API key（Console 计费）、Bedrock / Vertex / Foundry 凭证。这属于 Anthropic 明确允许的 "customers provision and manage their own API keys"。
- "等待官方开放"：目前未发现 Anthropic 有对应 OpenAI SIWC 的第三方订阅额度共享计划；应在 docs/roadmap.md 中把 Claude 订阅接入标注为"仅在 Anthropic 发布官方第三方授权机制后再评估"，而不是作为路线图承诺。
- 提供者接口设计仍应保持中立（AGENTS.md 要求），但不要为订阅令牌格式预留 Claude 专用字段。

## 5. 用户告知文案草稿（首次连接时显示）

标题：连接你的 ChatGPT 订阅前，请先了解

正文：

> 本插件通过 OpenAI 官方的 "Sign in with ChatGPT" 流程，请求使用你 ChatGPT Plus/Pro 订阅中包含的 Codex 额度，为本编辑器的 Agent 提供模型服务。本插件是开源、在你本机运行的第三方工具，不是 OpenAI 产品，也未获得 OpenAI 的背书。
>
> 请知悉以下风险：
> 1. **额度共享**：在这里产生的用量会计入你的 ChatGPT 订阅限额（Plus 用户的 5 小时窗口在所有应用间共享）。触达上限后请求会失败，插件不会自动改用其他付费方式。
> 2. **接口可能随时变更**：该接入方式目前处于 OpenAI 预览阶段，字段、模型目录、限额规则和资格可能在没有预告的情况下调整，导致功能暂时不可用。
> 3. **账号风险**：使用第三方工具访问订阅属于你与 OpenAI 之间的使用条款约束范围。虽然本插件遵循 OpenAI 公开的集成文档，但我们无法保证 OpenAI 不会调整政策或对异常用量采取限制措施。
> 4. **凭证保存在本机**：登录凭证会保存在本编辑器的安全存储中。请勿在共享电脑上长期保持登录；用完请在插件中登出，或前往 ChatGPT 设置 → Security and login → Sign in with ChatGPT 断开本应用。
>
> 你可以随时在 ChatGPT 设置 → Usage 中查看本应用的用量、设置每周限额或撤销授权。
>
> [继续使用 ChatGPT 登录]　[改用自己的 API Key]　[取消]

首次登录成功后（按 OpenAI UI/UX 指南）显示一次性确认："你正在使用自己的 ChatGPT 订阅。本应用中符合条件的 AI 请求将消耗该订阅额度，可在 ChatGPT 设置中管理。 [知道了]"

Claude 提供者的对应文案（如实现 API key 方式）："本插件不支持使用 Claude Pro/Max 订阅。Anthropic 不允许第三方应用使用 claude.ai 登录或订阅凭证。请使用你在 Claude Console 创建的 API key，费用由 Anthropic 直接向你计费。"

## 6. 来源列表

OpenAI / Codex

- OpenCode v1.2.27 旧版 Codex 插件源码：https://raw.githubusercontent.com/anomalyco/opencode/v1.2.27/packages/opencode/src/plugin/codex.ts
- OpenCode 当前（dev 分支）ChatGPT 提供者源码（已迁移到 SIWC）：https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/dev/packages/core/src/plugin/provider/chatgpt.ts
- OpenCode Providers 文档（OpenAI / Anthropic 小节）：https://opencode.ai/docs/providers/
- Codex app-server 文档（原 URL 重定向）：https://developers.openai.com/codex/app-server/ → https://learn.chatgpt.com/docs/app-server （Markdown：https://learn.chatgpt.com/docs/app-server.md）
- Codex 认证文档：https://learn.chatgpt.com/docs/auth.md
- Codex 开源组件说明：https://learn.chatgpt.com/docs/open-source.md
- Codex 定价/用量文档：https://learn.chatgpt.com/docs/pricing.md
- `@openai/codex` npm 元数据（0.163.0，Apache-2.0）：https://registry.npmjs.org/@openai/codex/latest ；许可证：https://raw.githubusercontent.com/openai/codex/main/LICENSE
- Sign in with ChatGPT 开发者文档索引：https://developers.openai.com/siwc.md
- SIWC Quickstart：https://developers.openai.com/siwc/quickstart.md
- SIWC Request a client ID（商业伙伴候补）：https://developers.openai.com/siwc/request-client-id.md
- SIWC ChatGPT plan usage 概览：https://developers.openai.com/siwc/token-sharing-open-source.md
- SIWC 注册与登录：https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md
- SIWC 账户与会话（刷新、撤销、凭证安全）：https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md
- SIWC 模型与推理：https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md
- SIWC 令牌参考：https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md
- SIWC 错误与恢复：https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md
- SIWC 预览限制：https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md
- SIWC 与 Codex app-server 组合：https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md
- SIWC UI/UX 指南：https://developers.openai.com/siwc/ui-ux-guidelines.md
- SIWC 用户文档（含 Open-source integrations 名单）：https://learn.chatgpt.com/docs/sign-in-with-chatgpt.md
- OpenAI Terms of Use（ROW 版本，Effective January 1, 2026）：https://openai.com/policies/row-terms-of-use/
- OpenAI Terms of Use（US 版本）：https://openai.com/policies/terms-of-use/ ——**抓取失败（连接错误），未能核对**
- OpenAI Usage Policies：https://openai.com/policies/usage-policies/ ——**抓取返回 HTTP 403，未能核对**

Anthropic / Claude

- Claude Code Legal and compliance（认证与凭证使用）：https://code.claude.com/docs/en/legal-and-compliance.md
- Claude Code Authentication：https://code.claude.com/docs/en/authentication.md
- Claude Code Setup（账户要求）：https://code.claude.com/docs/en/setup.md
- Claude Code 第三方集成（Bedrock/Vertex/Foundry）：https://code.claude.com/docs/en/third-party-integrations.md
- Claude Agent SDK Overview（第三方不得提供 claude.ai 登录）：https://platform.claude.com/docs/en/agent-sdk/overview
- Anthropic Consumer Terms of Service（Effective October 8, 2025）：https://www.anthropic.com/legal/consumer-terms
- Anthropic Usage Policy：https://www.anthropic.com/legal/aup

编辑器厂商

- Cursor Terms of Service（Last updated September 3, 2026）：https://cursor.com/terms-of-service
- Cursor Bring your own API key：https://cursor.com/docs/settings/api-keys
- Qoder Custom models：https://docs.qoder.com/qoder/custom-models
- Qoder Model selector：https://docs.qoder.com/qoder/model-selector
- Qoder Pricing（Free 含 BYOK）：https://docs.qoder.com/account/pricing
- Qoder Terms of Service：**未找到明确来源**（`https://qoder.com/terms`、`/terms-of-service`、`/legal/terms-of-service`、`/user-agreement` 均 404）
- Trae Built-in models & custom models：https://docs.trae.ai/ide/models
- Trae Terms of Service：https://www.trae.ai/terms-of-service ——页面为纯前端渲染，**条款全文未能抓取**
- VS Code Language models（BYOK / Custom Endpoint / 企业策略）：https://code.visualstudio.com/docs/copilot/customization/language-models

OAuth 安全参考

- RFC 8252 OAuth 2.0 for Native Apps（loopback 回调、PKCE）：https://www.rfc-editor.org/rfc/rfc8252
- RFC 9278 JWK Thumbprint URI（SIWC 推荐的 host-ID 形式）：https://www.rfc-editor.org/rfc/rfc9278.html
