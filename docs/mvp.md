# MVP：VS Code × Codex（Sign in with ChatGPT）

## 范围

MVP 只包含一条路径：**VS Code（Copilot Chat）原生 Agent × Codex 订阅模型**，Codex 通过 OpenAI 官方 Sign in with ChatGPT（SIWC）"ChatGPT plan usage" 开源客户端流程接入（选型依据见 [docs/risks.md §3](risks.md)）。

不在 MVP 内：

- Qoder 新版应用、Trae 的次级体验路线（`local-endpoint`），见 [docs/compatibility.md「对产品范围的影响」](compatibility.md#对产品范围的影响)。
- Qoder IDE、Cursor：不支持，待厂商开放。
- 任何 Claude 订阅接入（见「后续提供者」）。

## 必须覆盖

- VS Code 原生 Chat/Agent 接入：扩展通过 `LanguageModelChatProvider` 注册模型，模型声明 `toolCalling`，出现在 Agent 模式的模型选择器中。用户只需点选一次（无自动选中 API，见 [compatibility.md VS Code c 节](compatibility.md#c-程序化写入--零手填)）。
- Codex 浏览器登录：SIWC 动态注册 + PKCE + `127.0.0.1` 回调，自动回到编辑器；不复用 Codex CLI client_id，不调用 `chatgpt.com/backend-api`，不依赖 Codex CLI/app-server。
- 无需手动输入 API Key、URL、端口、JSON，也无需自行启动后端或安装运行时。
- 推理走 `https://api.openai.com/v1/responses`，协议转换层固化 SIWC 预览限制（`store:false`、`stream:true`、剔除不支持字段、系统消息转 `instructions`，见 [risks.md R3](risks.md)）。
- 模型发现（`GET /v1/models`）、访问令牌自动续期、重启恢复、重新登录和额度状态提示（429/403 不自动重试、不循环 OAuth，见 [risks.md R4](risks.md)）。
- 多轮工具调用、文件修改、终端执行、流式输出和取消。
- 连接流程符合 [SIWC UI/UX 指南](https://developers.openai.com/siwc/ui-ux-guidelines)：首次登录显示"正在使用 ChatGPT 订阅"确认、常驻用量标识、"Manage usage" 入口；首次连接前展示 [risks.md §5](risks.md) 的用户告知文案。
- 发布包负责需要的运行时，最终用户无需安装 Node.js 或 CLI。

## 验收标准

在真实 VS Code 稳定版 + 真实 ChatGPT 订阅上，由 Copilot Chat 原生 Agent 完成并记录以下证据（记录格式按 [compatibility.md「每端验证步骤」](compatibility.md#每端验证步骤)）：

1. 多轮工具调用往返：搜索代码 → 编辑文件 → 执行测试 → 修复，工具结果正确配对。
2. 文件修改、终端执行由 VS Code 执行，模型输出被正确消费。
3. 流式输出与中途取消。
4. 重启 VS Code 后自动恢复连接，无需重新登录。
5. access token 过期后自动续期；refresh token 失效或用户在 ChatGPT 设置中撤销授权后，进入"需要重新登录"状态并提供入口。
6. 额度用尽（429）与无资格（403）时显示明确状态，不自动重试。
7. 连接 UI 符合 SIWC UI/UX 指南。
8. Local 哈尼斯下通过；Copilot 哈尼斯（需实验设置 `chat.agentHost.byokModels.enabled`）单独记录结果。

## 实施清单

已完成：

- [x] 固化产品范围（方案 A：三档支持策略，见 [README](../README.md)）。
- [x] 四端接入可行性验证与证据记录（[compatibility.md](compatibility.md)）。
- [x] 合规与平台风险评估，选定 SIWC 路径（[risks.md](risks.md)）。
- [x] 核心接口与骨架重构：提供者契约、注册表、请求路由、编辑器接入契约。

进行中：

- [ ] `packages/core` Codex 提供者：SIWC 登录（动态注册、PKCE、loopback 回调、ID token 校验）、秘密存储、刷新去重、撤销处理、模型发现、Responses ↔ 核心消息转换与预览限制过滤。
- [ ] `packages/vscode-extension`：`LanguageModelChatProvider` 注册、`managementCommand`（登录/登出/重新登录）、状态提示、流式与取消、工具调用配对。
- [ ] VS Code 真实项目端到端验证并记录证据。

后续：

- [ ] `packages/local-endpoint`：面向 Qoder 新版应用 / Trae 的本地 OpenAI 兼容服务（先抓包确认请求发起侧为本机）。
- [ ] Agent Host（Copilot 哈尼斯）实验设置下的可用性验证。
- [ ] 打包、安装、升级、卸载与异常恢复验证；发布到扩展市场。
- [x] 开源许可证：MIT（根目录 `LICENSE`，满足 SIWC 开源、本地托管要求）。

## 后续提供者

仅接受官方允许的接入方式。**Claude Pro/Max 订阅接入已从路线图删除**（Anthropic 明确禁止第三方应用使用订阅凭证，见 [risks.md R5 / §4](risks.md)）；若增加 Claude 提供者，只支持用户自带 Anthropic API Key / Bedrock / Vertex / Foundry 凭证，且仅在 Anthropic 发布官方第三方授权机制后再评估订阅路线。

公共接口不得绑定 Codex 的令牌格式、模型命名或后端地址，也不为订阅令牌预留厂商专用字段。新增提供者前独立核对其条款与认证机制。
