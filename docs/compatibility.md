# 编辑器兼容性：原生 Agent 自定义模型接入可行性评估

本文是对产品目标（"安装插件 → 浏览器登录 → 直接用"，让编辑器原生 Chat/Agent 使用用户自己的 Codex 订阅模型）的**可行性评估**，不是支持声明。所有结论基于截至 2026-10-20 可抓取的官方文档与可靠来源；标注"非官方来源"的条目来自厂商员工在官方论坛的回复或社区反馈。任何编辑器都必须按文末"每端验证步骤"记录具体版本、操作系统和端到端（含工具调用往返）证据后，才能在 README 中声明支持。

结论三选一的含义：

- **可零配置**：插件安装后可通过公开 API 注册模型并以浏览器登录完成鉴权，用户不需要手填 API Key / URL / 端口。
- **需用户手填一次**：编辑器提供自定义 Base URL 的 GUI，但没有公开的程序化写入入口；用户需要在设置里把本地服务地址和一次性令牌粘一次。
- **公开机制下不可行**：没有自定义 Base URL，或请求由厂商服务端发起导致本机服务不可达。

## 总表

| 目标 | 接入方式类别 | 请求发起侧 | 可程序化写入配置 | Agent 限制 | 结论 | 主要来源 |
| --- | --- | --- | --- | --- | --- | --- |
| VS Code（GitHub Copilot Chat） | 扩展 API `LanguageModelChatProvider`（另有 Custom Endpoint GUI） | 本机（扩展宿主进程内） | 是：扩展代码注册模型，鉴权在 `provideLanguageModelChatInformation` 中触发；模型选择器仍需用户点选一次 | 模型需声明 `toolCalling`；Copilot 哈尼斯需开实验设置 `chat.agentHost.byokModels.enabled`；补全/语义搜索不走 BYOK | **MVP 零配置**（模型需在选择器里点选一次） | [LM Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)、[Language models](https://code.visualstudio.com/docs/agent-customization/language-models)、[1.104 发布说明](https://code.visualstudio.com/updates/v1_104) |
| Qoder IDE（VS Code 系） | 仅固定预设厂商 API Key | 文档未明示；预设厂商固定 URL，与本方案无关 | 否 | 文档未明示 | **不支持，待厂商开放** | [Qoder IDE Custom Models](https://docs.qoder.com/user-guide/chat/custom-models) |
| Qoder 新版桌面应用 | 自定义 Base URL 的 GUI（OpenAI Compatible：Chat Completions / Responses；Anthropic Compatible） | 文档未明示，待实测（间接证据指向本机） | 否：Plugins 是 Skills/MCP/Agents 包，不是模型提供者；无文档化模型配置文件 | 文档未明示；需在 GUI 填写上下文窗口/视觉/思考能力 | **后续次级体验**（手填一次） | [Qoder Custom models](https://docs.qoder.com/qoder/custom-models)、[Qoder Plugins](https://docs.qoder.com/qoder/plugins) |
| Trae（字节跳动） | 自定义 Base URL 的 GUI（OpenAI Chat Completions / Anthropic Messages 格式） | **已抓包（CN 3.4.4）**：TCP 由本机 `ai-agent` 发起，接受 `http://127.0.0.1`；报文由厂商服务端组装后经隧道下发，对话内容经服务端中转 | 否：`vscode.lm` 不被自研 Agent 消费；无命令/IPC/配置文件/deeplink 可注册模型（见 Trae 节 f、g） | Auto 模式不调用自定义模型；仅桌面版可添加；仅本地环境可用；CUE 补全固定内置模型 | **次级体验，已实现**（粘贴一次） | [TRAE 内置模型 & 自定义模型](https://docs.trae.com.cn/ide/models)、[TraeWork 模型](https://docs.trae.cn/work_models.md)、[Auto 模式](https://docs.trae.cn/ide_auto-mode.md) |
| Cursor | 固定厂商 API Key + "Override OpenAI Base URL"（官方文档已不再描述该选项） | **厂商服务端**（所有 BYOK 请求经 Cursor 服务器构造 prompt，localhost 不可达） | 否：仅 MCP 有扩展 API，模型无 | 仅"标准非推理 OpenAI 聊天模型"；Tab 补全不走 BYOK；需公网 HTTPS | **不支持，待厂商开放** | [Cursor BYOK](https://cursor.com/help/models-and-usage/api-keys)、[Cursor 员工回复（非官方文档）](https://forum.cursor.com/t/run-a-local-llm-model-with-cursor/156489/3) |

## VS Code（GitHub Copilot Chat）

### 结论：可零配置（模型需在选择器里点选一次）

### a. 自定义模型来源与方式类别

- **扩展 API**：`vscode.lm.registerLanguageModelChatProvider(vendor, provider)`，在 `package.json` 的 `contributes.languageModelChatProviders` 声明 `vendor`/`displayName`，可选 `managementCommand`。提供者实现 `provideLanguageModelChatInformation`、`provideLanguageModelChatResponse`、`provideTokenCount` 三个方法，响应可流式输出 `LanguageModelTextPart` / `LanguageModelToolCallPart` / `LanguageModelToolResultPart`。来源：https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- **Custom Endpoint GUI**（备选路线）：通过 "Chat: Manage Language Models" → Add Models → Custom Endpoint，支持 Chat Completions / Responses / Messages 三种 API 类型，配置写在 `chatLanguageModels.json`（`vendor: "customendpoint"`，`apiKey` 建议用 `${input:...}`，支持 `requestHeaders`、`statefulResponses`、`url` 自动发现模型）。该路线需用户在 GUI 粘一次 Key，因此是次级体验。来源：https://code.visualstudio.com/docs/agent-customization/language-models#_add-a-custom-endpoint-model
- 最低版本：API 在 **1.104（2025-09-11）** 完成最终化；官方示例 `engines.vscode: "^1.104"`。来源：https://code.visualstudio.com/updates/v1_104 ；https://github.com/microsoft/vscode-extension-samples/blob/main/chat-model-provider-sample/package.json
- 账户/计划限制：1.104 发布说明曾注明"通过此 API 提供的模型目前仅对 Copilot 个人计划用户可用"；当前文档（2026-10-14）改为"BYOK 模型无需登录 GitHub、无需 Copilot 计划即可使用"，但 Copilot Business/Enterprise 管理员可通过 GitHub 策略 "Bring Your Own Language Model Key in VS Code" 关闭。来源：https://code.visualstudio.com/docs/agent-customization/language-models#_bring-your-own-language-model-key

### b. 请求发起侧

扩展代码运行在本机扩展宿主进程中，`provideLanguageModelChatResponse` 由扩展自行向后端发起请求，因此请求来自用户本机。Agent Host 架构文档明确"Agent Host 运行位置不决定语言模型运行位置"，且扩展贡献的工具/模型只在扩展所在窗口可用。来源：https://code.visualstudio.com/docs/agents/concepts/agent-host

本方案可直接在扩展进程内调用 Codex 协议，不需要开本地 HTTP 端口。

### c. 程序化写入 / 零手填

- 模型注册完全由扩展代码完成，不需要写任何用户配置文件。
- 鉴权：`provideLanguageModelChatInformation(options: { silent })` 在 `silent=false` 时允许弹出交互（文档示例为 `promptForApiKey`），可替换为浏览器 OAuth 登录；`managementCommand` 可提供"重新登录/登出"入口。来源：同 a。
- **无法自动选中模型**：未找到允许扩展设置聊天模型选择器当前模型的公开 API。文档化的默认模型入口仅有：自定义 Agent 文件的 `model` 字段（Copilot 哈尼斯 / Local 子代理）、`inlineChat.defaultModel`、`chat.planAgent.defaultModel`、`chat.utilityModel` / `chat.utilitySmallModel` / `chat.byokUtilityModelDefault`。来源：https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference ；https://code.visualstudio.com/docs/agents/reference/ai-settings
  因此"零配置"的实际体验是：安装 → 浏览器登录 → 在模型选择器里点一次 Codex 模型（VS Code 会记住）。文档提示扩展模型若未立即出现需重载窗口。

### d. Agent 模式下的功能限制

- 模型必须在 `capabilities.toolCalling` 声明支持工具调用，否则不出现在 Agent 的模型选择器中。来源：https://code.visualstudio.com/docs/agent-customization/language-models#_add-a-model-from-a-built-in-provider
- **哈尼斯差异**：Local 哈尼斯（扩展宿主内）直接使用 VS Code 配置的模型，含 BYOK；**Copilot 哈尼斯**（Agent Host 进程）需开启实验设置 `chat.agentHost.byokModels.enabled`（默认 `false`，文档标注"可能变更或移除"）。来源：https://code.visualstudio.com/docs/agents/run/agent-harnesses ；https://code.visualstudio.com/docs/agents/reference/ai-settings#agent-host
- BYOK 不覆盖：内联补全（inline suggestions）、语义搜索（`#codebase` 嵌入）、依赖嵌入的功能；这些仍需 GitHub 账户 + Copilot 计划。内联补全可另行通过 `InlineCompletionItemProvider` 扩展 API 提供。来源：同上 FAQ。
- 未登录 GitHub 时内置 utility 模型不可用，需把 `chat.utilityModel`/`chat.utilitySmallModel` 指向 BYOK 模型或设 `chat.byokUtilityModelDefault` 为 "Main Agent Model"。

### e. 竞品/重叠路线（影响产品定位）

VS Code 已内置官方 **Codex 哈尼斯**：安装 OpenAI Codex 扩展，或开启实验设置 `chat.agentHost.codexAgent.enabled` 后在账户菜单 "Sign in to ChatGPT"（免费 ChatGPT 账户即可）。这条路线也是"浏览器登录直接用"，但它运行的是 Codex 自己的哈尼斯与工具集，而不是 Copilot/Local 哈尼斯。本产品的差异化在于把 Codex 订阅模型接进 **Copilot/Local 哈尼斯**，复用 VS Code 自身的工具、MCP、自定义 Agent、hooks。来源：https://code.visualstudio.com/docs/agents/run/agent-harnesses#codex

### 尚待实测

- 1.104 与当前稳定版（发布说明导航显示 1.142）之间 API 行为是否一致；`engines.vscode` 取值。
- Codex Responses 协议 → `LanguageModelChatRequestMessage` 的工具调用往返（`LanguageModelToolCallPart` / `ToolResultPart` 配对、流式、取消）。
- `chat.agentHost.byokModels.enabled` 开启后 Copilot 哈尼斯中 BYOK 模型的实际可用性与工具调用。
- 模型选择器是否在未重载窗口的情况下即时出现新模型。

## Qoder IDE（VS Code 系 IDE）

### 结论：公开机制下不可行

### a. 自定义模型来源与方式类别

仅支持固定预设厂商，输入 API Key：阿里云百炼、DeepSeek、Z.ai、Kimi、MiniMax、小米 MIMO。文档明确"Applicable For: Users with Individuals plans"。流程：Settings → Models → + Add → 选厂商与模型 → 填 API Key → 自动校验。**没有自定义 Base URL 字段。** 来源：https://docs.qoder.com/user-guide/chat/custom-models （纯文本：https://docs.qoder.com/user-guide/chat/custom-models.md ）

### b. 请求发起侧

文档未明示。由于目标 URL 固定为预设厂商，即使请求来自本机，也无法指向本地服务，与本方案无关。

### c. 程序化写入

无文档化配置文件或插件 API 可注册模型提供者。Qoder IDE 的扩展体系（Skills / Plugins / MCP / Custom Agent）均不涉及模型来源。来源：https://docs.qoder.com/llms.txt 目录中无相关条目。

### d. Agent 限制

文档未明示自定义模型在 Agent 模式下的限制；Repo Wiki 固定使用内置模型并单独计费。

### e. 依据

无自定义 Base URL，无扩展 API → 阻塞。除非 Qoder IDE 跟进新版应用的 "OpenAI Compatible" 能力，否则不列入 MVP。

### 尚待实测

- Qoder IDE 是否能加载第三方 VSIX 并暴露 `vscode.lm.registerLanguageModelChatProvider`（Qoder IDE 基于 VS Code，但其 Chat 面板是自研，预期不消费该 API；按 AGENTS.md，VSIX 能安装不等于支持）。

## Qoder 新版桌面应用

### 结论：需用户手填一次

### a. 自定义模型来源与方式类别

- 预设厂商扩展为：阿里云百炼、DeepSeek、Z.ai、Kimi、MiniMax、小米 MIMO、OpenAI、Google、OpenRouter。
- **自定义提供者**：Provider → Custom → **OpenAI Compatible**（可选 Chat Completions API 或 **Responses API**）或 **Anthropic Compatible**；填写 Base URL（示例格式 `https://api.example.com/v1`）、API Key、至少一个 Model ID，可添加多个 Model ID。
- 下一步需配置能力：显示名、支持的上下文窗口与默认值、Vision、Thinking Mode 及推理强度档位。点击 "Validate and Add Model" 校验后保存。
- 来源：https://docs.qoder.com/qoder/custom-models （纯文本：https://docs.qoder.com/qoder/custom-models.md ）

### b. 请求发起侧

文档未明示。间接证据：Network and proxy 页面说明代理设置"影响本地应用与本地 Agent，不影响 Remote SSH 主机"，说明模型请求由本地 Agent 进程发出的可能性高；但未见"本机直连 Base URL"的明确表述，**待抓包实测**（在本地起服务，观察 Qoder 是否直连 127.0.0.1）。来源：https://docs.qoder.com/qoder/network-proxy

### c. 程序化写入

- Plugins 定义为"打包的 Skills、connectors、Agents、commands、rules、Hooks"，不包含模型提供者。来源：https://docs.qoder.com/qoder/plugins
- Settings → Models 的描述是"Add and manage custom models with your own API key"，无配置文件路径或导入入口。来源：https://docs.qoder.com/qoder/settings
- Qoder CLI 有 "Custom Models (BYOK wizard)" 与配置文件参考，但未见与桌面应用共享模型配置的说明；按 AGENTS.md 不猜测未文档化的键。来源：https://docs.qoder.com/cli/custom-models.md

### d. Agent 限制

文档未明示自定义模型在 Agent/工具调用上的限制；能力（视觉/思考/上下文）需用户在 GUI 手动声明。Repo Wiki 固定使用内置模型并消耗 Credits。

### e. 依据

有 OpenAI Compatible + Responses API 的自定义 Base URL，技术上可指向本地连接器服务；但无程序化写入入口，用户必须手填 Base URL / Key / Model ID 一次 → 次级体验。

### 尚待实测

- 请求发起侧（见 b）。
- 本地服务是否允许 `http://127.0.0.1:<port>`（文档示例为 https）。
- Responses API 模式下的工具调用往返、流式与 `previous_response_id` 行为。
- 校验步骤对 `/v1/models` 或首个请求的要求。

## Trae（字节跳动）

### 结论：次级体验，已实现并验证（Trae CN 3.4.4 / 1.107.1，Windows，2026-10-21）

- 路线：扩展在 Trae 中自动启动 `local-endpoint`（`http://127.0.0.1:46117/v1`），用户在 *设置 → 模型 → 添加自定义模型 → 自定义配置*（OpenAI Chat Completions 格式）粘贴一次 Base URL / 安装级密钥 / 模型 ID。
- 证据：连通性校验（含 `image_url`）通过；Builder 模式下使用 `gpt-6.1-sol` 完成含 27 个工具定义的 Agent 请求并正常返回（扩展日志：`messages=2 tools=27 stream=true → status=200`）；用户确认可正常使用。请求发起侧与报文形状见 h 节。
- 边界：`vscode.lm` 零配置路线不可用（f、g 节）；Auto 模式不使用自定义模型；对话内容经 Trae 服务端中转。

说明：国际站 https://docs.trae.ai/ide/models 及其 `.md`、`/llms.txt` 仅返回页面标题（JS 渲染，未能获取正文）；以下依据来自中文站同一文档。

### a. 自定义模型来源与方式类别

- 两类来源：**模型服务商**（预设厂商 + API 密钥，部分厂商可选"按量计费 / Coding Plan / Agent Plan"）和 **自定义配置**。
- 自定义配置字段：API 格式（**OpenAI Chat Completions 格式** 或 **Anthropic Messages 格式**；无 Responses API）、自定义请求地址（"完整 URL" 开关：开则填完整地址，关则填基础地址由 TRAE 拼接路径）、模型 ID、模型展示名称、API 密钥。
- 高级配置：模型系列（GPT-5 / Gemini-3 / DeepSeek-4 / 默认；Kimi / GLM-5 / GPT-6 / Claude-4 系列仅企业版）、上下文窗口、**工具调用轮数**、支持图片输入、思考模式、采样参数。
- 添加时 TRAE 调用服务商接口校验密钥，失败会展示服务商返回的日志。
- 来源：https://docs.trae.com.cn/ide/models （纯文本：https://docs.trae.cn/ide_models.md ）

### b. 请求发起侧

文档未明示。间接证据：（1）文档将"部分 Ollama/OpenAI 兼容代理"列为可接入服务；（2）TraeWork 文档限制"仅桌面版支持添加自定义模型；添加的自定义模型仅支持在本地环境中使用"，即云端任务不可用自定义模型。两者都与"本机发起请求"一致，但**待抓包实测**。来源：https://docs.trae.cn/work_models.md

### c. 程序化写入

- 文档化的配置文件只有权限 `global.json`、Hook 配置、MCP 配置与 MCP Server 安装链接（deeplink schema）；**模型配置无文档化文件或 API**。来源：https://docs.trae.cn/ide_custom-permission-mode-configuration-reference.md ；https://docs.trae.cn/ide_hook-configuration-reference.md ；https://docs.trae.cn/ide_mcp-server-install-links.md
- TRAE 可从 VS Code 插件市场安装插件或导入 `.vsix`，但其 Chat/Agent 为自研，没有说明消费 `vscode.lm` API。来源：https://docs.trae.cn/ide_manage-extensions.md

### d. Agent 限制

- **Auto 模式仅调用内置模型，不调用自定义模型。** 来源：https://docs.trae.cn/ide_auto-mode.md
- Max 模式仅对"支持 Max 模式的模型"开放（内置模型）。来源：https://docs.trae.cn/ide_max-mode.md
- CUE 代码补全为内置能力，不随自定义模型切换。来源：https://docs.trae.cn/ide_cue.md
- 自定义模型可设置"工具调用轮数"，表明 Agent 工具调用对自定义模型开放；具体 SOLO Agent 下的表现待实测。
- TraeWork：仅桌面版可添加，仅本地环境可用。

### e. 依据

有自定义 Base URL（Chat Completions / Messages 格式），但没有程序化写入入口，用户必须在设置里手填一次 → 次级体验。另注意：API 密钥为必填字段，本地连接器需提供一次性令牌供用户粘贴。

### f. 本机安装包静态取证（Trae CN 1.107.1，Windows，2026-10-21）

对象：`%LOCALAPPDATA%\Programs\Trae CN`，`product.json` 中 `version: 1.107.1`、`vscodeVersion: 1.107.1`、`buildBranch: release_desktop_yoma_win32_cn`、`date: 2026-10-16`。以下为对已发布构建的字符串/结构分析，不是运行时抓包。

**`vscode.lm` 提供者路线（VS Code 零配置同款）：不可用。**

- 扩展宿主 `out/vs/workbench/api/node/extensionHostProcess.js` 保留了上游 `registerLanguageModelChatProvider` / `ExtHostLanguageModels`；workbench 保留了 `languageModelChatProviders` 贡献点与 `MainThreadLanguageModels`。即 VSIX 可以安装并注册提供者。
- 但 `workbench.desktop.main.js` 中 `ILanguageModelsService` 的全部 22 处注入点都属于上游 VS Code chat（`chat.ChatSessionStore`、prompt 文件校验、chat 内置工具、模型选择器、账户菜单 "Manage Models" 等）；Trae 自研 Agent 的模块（`ICubeAI` 162 处、`iCubeChat` 55 处）**没有任何一处**引用该服务。
- Trae 把上游配置 `chat.disableAIFeatures` 的默认值改为 `true`（上游默认 `false`），上游 chat 由 `workbench.contrib.chatTeardown` 整体拆除；`defaultChatAgent` 仍指向 `GitHub.copilot-chat` 且文档 URL 为 `https://example.com` 占位。
- 结论：装上 unify-provider VSIX 后，提供者会被注册，但 Trae 原生 Agent 不会消费它；能消费它的上游 chat 面板默认关闭，且即便手动打开也不是 Trae 的原生 Agent（按项目规则不算等价实现）。

**自定义模型 GUI 路线（次级体验）：架构已明，发起侧待运行时确认。**

- Trae 原生 Agent 由渲染层 `[ai-chat]` 通过 AHA IPC 调用本机子进程 `ai-agent`（Rust，`resources/app/modules/ai-agent/ai_agent.dll`，`meta.json` 声明 socket 端口 40005；`main.log` 记录 `ai-agent process spawned`）。
- `ai_agent.dll` 内含 `custom-model-proxy-client` crate（`[CustomModelProxy]` 日志前缀 49 处），路径模板 `GET /custom_model/tunnel/{id}/pending`、`POST /custom_model/tunnel/{id}/messages`，待处理请求方法包含 `sse.open` / `sse.cancel`，并区分 "HTTP mode" 与 WebSocket 模式；`product.json` 对应 `bootConfig.ws.trae.normal = wss://trae-ws-cn.mchost.guru/custom_model`。
- 同一 DLL 的 `[LLMAdapter]` 具备本地直连能力：厂商列表 `openai / anthropic / deepseek / openrouter / xai / aws(bedrock) / foundation-models`，路径 `/v1/chat/completions`、`/v1/messages`，请求头 `Authorization: Bearer` / `x-api-key` + `anthropic-version: 2023-06-01`，并有 `llm_raw_chat_custom_model` 与 `custom_model_connectivity_check generate_http_headers` 日志。
- 模型配置结构体字段含 `provider, is_preset, config_source, model_name, ak, base_url, custom_model_uniq_id, use_remote_service, multimodal, prompt_max_tokens, toolcall_history_max_tokens, encrypted_model_params`；管理接口 `api/ide/v1/add_custom_model`、`api/ide/v1/update_custom_model`、`api/ide/v1/get_custom_model_type_config`、`api/agent/v3/custom_model_connectivity_check` 为 Trae 服务端 API。
- **推断**（待抓包证实）：Agent 编排在 Trae 服务端完成；服务端需要调用自定义模型时，通过反向隧道把 LLM 请求下发给本机 `ai-agent`，由本机 `LLMAdapter` 用用户填写的 Base URL/Key 实际发起 HTTP 并以 SSE 回传。因此 `http://127.0.0.1:<port>` 的本地端点在原理上可达；`use_remote_service` 字段暗示部分配置可能改由服务端直连，需确认本地地址不会命中该分支。
- **注意事项**：对话内容与模型输出会经由 Trae 服务端中转；`ak` 字段随 `add_custom_model` 提交到服务端。`local-endpoint` 若实现，必须只接受一次性本地令牌，不得把 Codex 凭证作为 API 密钥填入 Trae。

### g. 零配置缝隙穷举（同一构建，静态只读，2026-10-21）

目标：找一条"装扩展即可用、不改 Trae 二进制、不猜未公开键"的路径。逐项排查结果：

| 候选缝隙 | 观察 | 判定 |
|---|---|---|
| `vscode.lm` 提供者 | 可注册；Trae 自研 Agent 零引用（见 f） | 不可用 |
| 扩展调用 Trae 注册的命令 | 已定位 `workbench.action.openTraeSettings`、`icube.userConfiguration.get/update`、`_icube.extended.integrations.llm.*`（仅管理 Integrations 的 provider/apiKey，写扩展自己的 `workspaceState`，不接 Base URL/模型 ID，不调 `model/add_custom_model`）、`icube.ai.agentImport` 等；无一能注册原生 Agent 自定义模型 | 不可用 |
| 扩展直接走 Aha IPC 调 `model/add_custom_model` | GUI 实际路径是 React → `ModelAPIService` → `TransportManager` → `vscode.ahaIpc.connect()` → 本机 `ai-agent`；但 `ahaIpc` 是 Electron preload 桥（`sandbox/electron-browser/preload.js`），`extensionHostProcess.js` 全文无 `ahaIpc`，扩展 API 对象只含 `icube` / `icubeAI` / `trae`；`vscode.icube.getWebSocketRpcClient` 对应 workbench 实现为 `throw new Error("$makeRPCClient not implemented")`。`@aha-kit/ipc` 为 ZeroMQ ROUTER/DEALER + `ipc://…\aha\<name>.sock`，与 Electron 内建实现是否互通未验证 | 现状不可用；即便打通也是未公开协议 |
| `add_custom_model` 的权威端 | `ai_agent.dll` 同时含 `api/ide/v1/add_custom_model` 等服务端路径与本地 `model_config_cache(user_id, env, function, config_data, updated_at)` 缓存表 + `keep_syncing_model_info` 同步；本地 DB（`%APPDATA%\Trae CN\ModularData\ai-agent\database.db`）非普通 SQLite 文件头，DLL 含 `[DB] Database is already encrypted` | 模型目录为服务端权威 + 加密本地缓存；写 DB 不可行 |
| deeplink / 配置键 | `urlProtocol: trae-cn`，路由含 `/side-chat`、`/agent/share`、`/mcp-import`、`/skill-import`，无模型路由；`ai_assistant.*`、`AI.agent.*`、`trae.network.*` 配置键均与 provider/Base URL 无关 | 不存在 |
| 环境变量 `LOCAL_MODEL_CONFIG_DIR` / `LOCAL_IAC_DIR` | 仅在 `ai_agent.dll` 环境变量名表出现各 1 次（0xA3D33B4 附近），无相邻文件名、schema、加载日志；`harness.dll` / `toolhost.dll` 为 0 次 | 证据不足；且需 ai-agent 启动前生效，不构成零配置 |
| proposed API 白名单 | `_envEnablesProposedApiForAll` 硬编码 `true`，`product.json` 无 `extensionEnabledApiProposals`；但已暴露的 `vscode.trae` 仅 MCP provider/server/transport 与 session hook，`icubeAI` 仅 `onAiTaskComplete` | 没有形成"扩展 → 模型注册 → 原生 Agent"闭环 |
| 补充：GUI payload | `provider` 枚举 `custom_openai_compatible` / `custom_anthropic_compatible` / **`custom_responses_compatible`**（模块内含第三项，UI 是否可见待实测）；默认追加 `/chat/completions`、`/v1/messages`、`/responses`；`auth_type 0=API_KEY, 1=AK_SK`；`config_source 1=Trae, 2=Enterprise, 3=Personal` | 对 local-endpoint 的协议选择有用 |

**结论**：在"不改二进制、不猜未公开键/协议"的约束下，Trae CN 3.4.4 / 1.107.1 没有零配置接入路径。能做到的上限是：扩展启动本地端点 → 调 `workbench.action.openTraeSettings` 打开模型设置页 → 用户粘贴一次 Base URL / 一次性令牌 / 模型 ID（次级体验）。若产品原则只接受零配置，则 Trae 应标注"不支持，待厂商开放"，并向 Trae 提出需求：原生 Agent 消费 `vscode.lm`，或提供文档化的模型提供者注册 API。

### h. 运行时抓包（Trae CN 3.4.4 / 1.107.1，Windows，2026-10-21）

方法：在 `127.0.0.1:18080` 起一个仅记录请求、返回最小合法 Chat Completions 响应的探针（合成令牌 `probe-token-123`，不含任何真实凭证）；在 Trae 设置里以"自定义配置 / OpenAI Chat Completions / `http://127.0.0.1:18080/v1` / 模型 ID `probe-model`"添加模型，然后在 Builder 模式发送一条消息。

**观察**

| 项 | 连通性校验请求 | Agent 对话请求 |
|---|---|---|
| TCP 来源 | `127.0.0.1:52654` | `127.0.0.1:50589` |
| 方法/路径 | `POST /v1/chat/completions`（Trae 自动在 Base URL 后拼接 `/chat/completions`） | 同左 |
| `authorization` | `Bearer <用户填写的密钥>` | 同左 |
| `user-agent` | `hertz`（CloudWeGo Hertz，Go 服务端框架） | 同左 |
| `x-model-provider` | `custom_openai_compatible` | 同左 |
| `acl-token` | 服务端内部 JWT（`authority: TCE`，`psm: flow.ide.copilot`，含 `idc` / `physical_cluster` / `zone: China-North` 等集群字段） | 同左（不同 cluster） |
| `x-forwarded-for` | `fdbd:dc03:…`（服务端内网 IPv6） | 同左 |
| 请求体字段 | `model, max_tokens: 16000, stream: true, messages` | `model, max_tokens: 16000, stream: true, tools, messages` |
| `messages` | 1 条 user，`content` 数组：`image_url`（32×32 PNG data URL）+ `text: "图片背景是什么颜色"` | `system`（字符串，约 21 KB，TraeCode Agent 提示词）+ `user`（6 个 `text` 段：终端状态、todo 提醒、工作区 AGENTS.md 规则、语言设置、模式、`<user_input>`） |
| `tools` | 无 | 27 个 `{type:"function", function:{name, description, parameters}}`，约 70 KB：Task、Skill、Glob、LS、Grep、Read、WebSearch、WebFetch、RunCommand、CheckCommandStatus、StopCommand、GetDiagnostics、DeleteFile、SearchReplace、Write、TodoWrite、AskUserQuestion、NotifyUser、OpenPreview、get_goal、create_goal、update_goal、PureShowWidget、Schedule、RequestAuthorization、browser_waiting_for_user_interaction、run_mcp |
| 未出现的字段 | `stream_options`、`tool_choice`、`temperature`、`top_p` | 同左 |
| 探针响应 | 非流式/流式 `PROBE_OK` 均被接受；模型添加成功，对话正常显示 | 同左 |

**结论**

1. **TCP 连接由本机发起**（本机 `ai-agent` 进程），`http://127.0.0.1` 被接受 → `local-endpoint` 路线成立，不降级。
2. **HTTP 报文由 Trae 服务端组装**（`hertz` UA、内部 JWT、内网 `x-forwarded-for`）后经隧道下发本机转发，证实 f 节推断：提示词、工具清单、工具结果与模型输出全部经由字节跳动服务端中转。README/用户提示须明确告知。
3. `local-endpoint` 的 Trae 适配面 = **OpenAI Chat Completions 流式 + function tools + 多模态 `image_url` 输入**，需转换为 Codex Responses API；连通性校验会发送一张图片，端点必须真实转发（不得伪造成功）。
4. 端点应忽略并**不记录** `acl-token`、`x-forwarded-for` 等第三方内部头；仅校验 `authorization` 中的一次性本地令牌。

### 尚待实测

- 国际版 TRAE 文档正文（未能获取，待实测/重新抓取）。
- 工具调用**往返**：探针未返回 `tool_calls`，Trae 对流式 `tool_calls` delta 的解析、`role: tool` 消息回填格式、以及 `reasoning_content` 字段的处理仍需在真实端点上验证。
- API 格式下拉是否可见第三项 `custom_responses_compatible`（若可见则可免去 Chat Completions → Responses 转换）。
- 自定义模型在 IDE 侧边对话与 SOLO Agent 两种模式下的行为差异。

## Cursor

### 结论：公开机制下不可行（localhost 本地服务路线被阻塞）

### a. 自定义模型来源与方式类别

- 官方文档"Bring your own API key"：Cursor Settings → Models，支持 **OpenAI / Anthropic / Google / Azure OpenAI / AWS Bedrock** 五类固定厂商的 API Key。文档未再描述 "Override OpenAI Base URL" 选项；该选项在 2026-01 至 2026-08 的 Cursor 员工论坛回复中仍被提及为存在。来源：https://cursor.com/help/models-and-usage/api-keys ；https://forum.cursor.com/t/run-a-local-llm-model-with-cursor/156489/3 （非官方文档，CursorStaff 回复）
- OpenAI 条目限定为 "Standard, non-reasoning chat models"，即 GPT-5.x-Codex 一类推理模型不在 BYOK 范围。来源：同上官方页。

### b. 请求发起侧：厂商服务端

- 官方文档："Your API key is not stored on our servers. **It is sent to our backend with every request because all requests are routed through Cursor's servers for final prompt building.**" 来源：https://cursor.com/help/models-and-usage/api-keys#will-my-api-key-be-stored-or-leave-my-device
- Cursor 员工 Dean Rie（CursorStaff）2026-04-02："Right now, Cursor doesn't support directly connecting to local models via localhost. **All BYOK requests go through Cursor servers to build prompts, so you need a public HTTPS endpoint.**" 推荐 ngrok / Cloudflare Tunnel 作为变通；"The team is aware of the request for native support for local models without tunneling." 来源：https://forum.cursor.com/t/run-a-local-llm-model-with-cursor/156489/3 （非官方文档）。同类回复另见 https://forum.cursor.com/t/152940 、https://forum.cursor.com/t/152419 、https://forum.cursor.com/t/148311 。
- AWS Bedrock 路线同样是 Cursor 服务端通过 IAM 角色跨账户调用（信任策略中为 Cursor 的 `arn:aws:iam::289469326074:role/roleAssumer`）。来源：https://cursor.com/docs/customizing/aws-bedrock

结论：社区"Override Base URL 由服务端请求、localhost 不可达"的反馈**被官方文档与官方员工回复确认**。

### c. 程序化写入

- Cursor 提供 `vscode.cursor.mcp.registerServer()` 扩展 API 和 `~/.cursor/mcp.json` 用于 **MCP**；**模型提供者没有对应 API 或配置文件**。来源：https://cursor.com/docs/mcp#using-the-extension-api
- 企业版可在 Dashboard 控制模型开关与 BYOK 策略（仅限制，不能新增提供者）。来源：https://cursor.com/docs/enterprise/model-and-integration-management

### d. Agent 限制

- "Custom API keys only work with chat models. Tab completion continues using Cursor's built-in models." 来源：https://cursor.com/help/models-and-usage/api-keys
- OpenAI BYOK 仅非推理聊天模型（见 a）。
- Teams/Enterprise 使用 BYOK 仍收 Cursor Token Rate（$0.25/M tokens）。
- 社区反馈（非官方）：BYOK + Base URL 覆盖下图片/视觉请求报错；免费账户下 BYOK 聊天不可用、Agent 需付费计划。来源：https://forum.cursor.com/t/158460 ；https://forum.cursor.com/t/140521

### e. 依据

本方案的核心是本机连接器进程持有 Codex 订阅凭证并转换协议；Cursor 要求 Base URL 为 Cursor 服务端可达的公网 HTTPS，意味着必须把用户的 Codex 会话经由公网隧道暴露给 Cursor 服务器，既违背"零配置"也带来凭证外泄面。公开机制下不可行；不列入 MVP。

### 尚待实测

- 当前 Cursor 版本中 "Override OpenAI Base URL" 是否仍存在及位置。
- 若未来 Cursor 提供客户端直连本地模型（员工表示团队已知悉该需求），再重新评估。

## 对产品范围的影响

按方案 A 将五个目标归入三档（总表结论列用语与此对应：可零配置 → MVP 零配置；需用户手填一次 → 后续次级体验；公开机制下不可行 → 不支持，待厂商开放）。各档的架构落位见 [docs/architecture.md「三档支持策略」](architecture.md#三档支持策略)。

| 档位 | 目标 | 说明 |
| --- | --- | --- |
| MVP 零配置 | VS Code（Copilot Chat） | `LanguageModelChatProvider` 扩展 + SIWC 浏览器登录，扩展进程内直连，无需本地 HTTP 端口。遗留摩擦：模型选择器需用户点选一次；Copilot 哈尼斯需开实验设置；补全/语义搜索不受益。需与官方 Codex 哈尼斯明确差异化。 |
| 次级体验（粘贴一次） | Trae（已实现）、Qoder 新版应用（后续） | 由 `local-endpoint` 提供本地 OpenAI Compatible 服务（Trae 走 Chat Completions；Qoder 可能需 Responses 入站）+ 安装级密钥，并提供"复制配置"引导；用户在设置里手填一次 Base URL / Key / Model ID。Trae 已抓包确认 TCP 由本机发起（见 Trae 节 h），但报文由厂商服务端组装、对话内容经服务端中转；Qoder 新版应用请求发起侧仍待抓包确认，若确认为服务端发起则降级为不支持。 |
| 不支持，待厂商开放 | Qoder IDE、Cursor | Qoder IDE 无自定义 Base URL；Cursor 请求由服务端发起且 OpenAI BYOK 仅限非推理模型。不投入适配器开发，README 中不得声称支持；仅跟踪厂商更新。 |

架构含义：

- 核心协议层（SIWC 登录与刷新、Responses ↔ 核心消息转换、工具调用配对、预览限制过滤）与编辑器适配器解耦；`local-endpoint` 已在其上复用同一核心。
- `local-endpoint` 是可选组件，仅服务次级体验目标、仅在该路线下自动启动，绑定 127.0.0.1、要求安装级密钥；新增目标编辑器前仍须先抓包确认请求发起侧。

## 每端验证步骤

1. 确认插件安装、引擎版本和实际可调用的 API（VS Code：`vscode.lm.registerLanguageModelChatProvider` 是否存在且模型出现在选择器）。
2. 以最小模拟后端验证模型注册或自动配置，不先依赖真实订阅。
3. 由原生 Agent 发起请求，保留角色、上下文和工具定义；对 Qoder/Trae 同时抓包确认请求来自本机。
4. 返回工具调用，确认编辑器执行工具并将匹配的结果传回（工具调用往返）。
5. 验证流式、停止、重启恢复和配置清理（含卸载时移除本插件写入的配置）。
6. 接入真实 Codex 订阅并完成搜索代码、编辑、执行测试和修复。

若没有公开的原生接入机制，记录阻塞原因；独立聊天面板不能作为兼容完成的证据。

## 起始资料

- VS Code 模型提供者 API：https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- VS Code 自定义模型 / BYOK：https://code.visualstudio.com/docs/agent-customization/language-models
- VS Code 1.104 发布说明（API 最终化）：https://code.visualstudio.com/updates/v1_104
- VS Code AI 设置参考（`chat.agentHost.byokModels.enabled` 等）：https://code.visualstudio.com/docs/agents/reference/ai-settings
- VS Code 哈尼斯与官方 Codex 路线：https://code.visualstudio.com/docs/agents/run/agent-harnesses
- VS Code Agent Host 架构：https://code.visualstudio.com/docs/agents/concepts/agent-host
- VS Code 示例扩展：https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample
- Qoder IDE 自定义模型：https://docs.qoder.com/user-guide/chat/custom-models
- Qoder 应用自定义模型：https://docs.qoder.com/qoder/custom-models
- Qoder 应用 Plugins：https://docs.qoder.com/qoder/plugins
- Qoder 文档索引：https://docs.qoder.com/llms.txt
- TRAE 内置模型 & 自定义模型：https://docs.trae.com.cn/ide/models
- TraeWork 模型：https://docs.trae.cn/work_models.md
- TRAE Auto 模式：https://docs.trae.cn/ide_auto-mode.md
- TRAE 文档索引：https://docs.trae.cn/llms.txt
- Cursor BYOK：https://cursor.com/help/models-and-usage/api-keys
- Cursor MCP 扩展 API：https://cursor.com/docs/mcp
- Cursor 员工关于 localhost 的回复（非官方文档）：https://forum.cursor.com/t/run-a-local-llm-model-with-cursor/156489/3
- Codex app-server：https://developers.openai.com/codex/app-server/
