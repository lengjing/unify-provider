# 架构

## 产品边界

用户安装插件并通过浏览器登录已有订阅，在编辑器原生 Chat/Agent 中工作。编辑器负责上下文选择、工具执行、权限和编辑审阅。Unify Provider 负责账户连接与模型输出；它是开源、本机运行的第三方工具，不是编辑器或模型厂商的产品。

## 三档支持策略

依据 [docs/compatibility.md](compatibility.md) 的证据将目标编辑器分为三档；归类变化必须先更新该文档。

| 档位 | 目标 | 接入方式 | 阶段 |
| --- | --- | --- | --- |
| 零配置 | VS Code（Copilot Chat） | 扩展内 `LanguageModelChatProvider`，进程内直接调用核心；无本地 HTTP 端口。用户在模型选择器点选一次 | MVP |
| 次级体验 | Qoder 新版应用、Trae | 插件/本地程序启动 `local-endpoint`，用户在编辑器设置里手填一次 Base URL / Key / Model ID | 后续 |
| 不支持，待厂商开放 | Qoder IDE、Cursor | 无公开可行机制；不开发适配器，仅跟踪厂商更新 | — |

## 两侧适配

- 编辑器侧：VS Code 使用原生模型提供者 API；次级体验编辑器使用本地 OpenAI 兼容服务。能够复用的插件 API 共用实现；不同机制使用独立适配器。
- 提供者侧：首个提供者为 Codex；后续提供者仅限官方允许方式（见 [docs/roadmap.md「后续提供者」](roadmap.md#后续提供者)）。提供者负责登录和协议，核心不依赖特定厂商。
- 核心：账户/模型标识、提供者注册、请求路由、流式事件、取消。工具调用由编辑器执行，结果随下一次请求传回。
- 传输：VS Code 扩展直接调用核心；`local-endpoint` 是可选传输，把核心暴露为 OpenAI 兼容 HTTP 端点。

## Codex 接入：Sign in with ChatGPT

采用 OpenAI 官方 SIWC "ChatGPT plan usage" 开源客户端流程，三条路径的对比见 [docs/risks.md §3](risks.md)：

- **已采用（C）**：`client_id=dynamic_agent_client` 动态注册 → PKCE + `127.0.0.1` 回调 → scope `chatgpt.tokens.use.direct` → 推理直连 `https://api.openai.com/v1/responses`，模型列表 `GET /v1/models`。无需 client secret 或 Codex CLI。
- **已否决（A）**：复用 Codex CLI client_id 并改写到 `chatgpt.com/backend-api`。理由：未公开接口、借用他人客户端标识，OpenAI 文档明确要求不要指向 backend-api（[risks.md R1](risks.md)）。
- **已否决（B）**：Codex app-server 作为推理通道。理由：它是 Codex 自己的 Agent 运行时而非裸模型端点，接入编辑器原生 Agent 会变成"Agent 套 Agent"，且需随包分发 Codex CLI 二进制（[risks.md R2](risks.md)）。

协议转换层须固化 SIWC 预览限制：`store:false`、`stream:true`、剔除 `temperature`/`max_output_tokens`/`previous_response_id` 等不支持字段、系统消息改为 `instructions`、工具以 function/custom tools 形式传递，历史完整放入 `input`（[risks.md R3](risks.md)）。

SIWC 仅面向开源、本地托管应用：项目必须保持开源，不收费、不远程托管；`agent_name_hint` 使用稳定的真实产品名。

## local-endpoint 的定位

`packages/local-endpoint` 仅服务次级体验编辑器。Trae 已按前提完成抓包（[compatibility.md](compatibility.md) Trae 节 h：TCP 由本机 `ai-agent` 发起，报文由 Trae 服务端组装后经隧道下发）并实现：仅绑定 `127.0.0.1`、`Authorization: Bearer` 安装级密钥、OpenAI Chat Completions（流式、function tools、`image_url` data URL）→ 核心契约 → 提供者。扩展负责启动/关闭、密钥与端口持久化、"复制配置"引导。Qoder 新版应用待抓包后再决定是否增加 Responses 入站格式。

## 当前代码

`packages/core/src/core/provider.ts` 是初始接口，包括流式工具参数、工具结果、图片、推理强度和不透明的提供者状态；随 SIWC 协议落地演进。`ProviderRegistry` 实现明确提供者路由，不自动回退到其他付费账户。

`packages/core/src/editors` 仅定义接入接口和目标清单，没有实现编辑器检测或自动配置。`probe()` 应以运行时实际能力和已验证路径为依据，不凭产品名推断兼容性。

## 待验证决策

1. VS Code：Copilot 哈尼斯（`chat.agentHost.byokModels.enabled`）下 BYOK 模型的工具调用实际表现；模型是否无需重载窗口即出现。
2. 远程场景（SSH/WSL/容器）中扩展宿主位置与 `127.0.0.1` 浏览器回调的路由。
3. 次级体验编辑器的请求发起侧（决定 `local-endpoint` 是否可行）。
4. ~~开源许可证~~ 已决定：MIT（根目录 `LICENSE`）。

## 凭证与生命周期

- 存储：凭证由宿主秘密存储保存（VS Code SecretStorage），不写入仓库、普通设置或日志。需持久化的非凭证状态：SIWC 签发的 `client_id`（`oaiapp_...`）与稳定的 `ext_agent_host_id`（不得由邮箱等可识别信息生成）。
- 登录：每次生成新的 `state`、`nonce`、PKCE verifier；回调只接受 `http://127.0.0.1:<port>/auth/callback`，端口临时分配，不使用 `localhost` 与固定端口 1455（[risks.md R7](risks.md)）；5 分钟超时；取消登录需清理监听器和回调服务。
- 续期：access token 1 小时、refresh token 30 天且轮换；同一会话的刷新必须去重串行化，避免多窗口竞争轮换令牌。
- 撤销：用户可在 ChatGPT 设置中断开应用且 OpenAI 不会通知；收到 `invalid_grant` 或等价错误时转入 `reauthentication-required` 状态，不自动循环 OAuth。登出时调用 revocation endpoint 并清理本地。
- 额度：429/403 直接呈现状态并链接 `chatgpt.com/settings/usage`，不重试、不切换计费路径（[risks.md R4](risks.md)）。
- 重启恢复不依赖临时端口不变。配置变更保留用户现有模型，记录自身拥有的配置；停止插件与移除配置是不同操作。
