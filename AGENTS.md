# 项目指引

- 产品：开源、本机运行的统一 AI 提供者连接器，让编辑器原生 Chat/Agent 使用用户已有的模型订阅/账号；Codex 是第一个提供者，不是产品本身。支持分三档（见 README）：VS Code 零配置；Trae 次级体验（已实现，粘贴一次）、Qoder 新版应用（后续）；Qoder IDE、Cursor 不支持，待厂商开放。
- 当前提供者仅 Codex。提供者接口保持中立，不绑定 Codex 的令牌格式、模型命名或后端地址；文档与 UI 以"统一提供者"口径表述。
- Codex 仅允许 OpenAI 官方 Sign in with ChatGPT（ChatGPT plan usage）开源客户端流程（依据 docs/risks.md）。三条禁止：不得复用 Codex CLI 的 client_id；不得调用 `chatgpt.com/backend-api`；不得依赖 Codex CLI / app-server。
- SIWC 仅面向开源、本地托管应用：项目以 MIT 许可证开源（根目录 LICENSE），必须保持开源、不收费、不远程托管；新增包的 package.json 须声明 `"license": "MIT"`。
- Claude Pro/Max 订阅凭证一律不得接入、读取或中介（Anthropic 明确禁止）。后续 Claude 提供者只允许用户自带 API Key / Bedrock / Vertex 等官方允许方式。
- 编辑器接入与订阅协议相互独立。核心不得导入 VS Code API 或 Codex 专有实现。
- 必须接入原生 Agent；单独的聊天面板不算等价实现。
- 不得仅凭 VSIX 可安装就宣称支持某编辑器。须在 docs/compatibility.md 中记录具体版本的原生 Agent 与工具往返证据。
- 对 Cursor、Qoder IDE 不得声称支持；状态措辞统一为"不支持，待厂商开放"。
- Qoder IDE 与 Qoder 新版应用是不同产品，需分别验证并分别记录。
- `packages/local-endpoint` 仅服务次级体验目标，仅在这些编辑器中自动启动。Trae 已抓包并实现；接入新的目标编辑器前须先抓包确认其请求由本机发起。
- 优先使用有文档的集成与配置 API。不得静默修改编辑器二进制，不得猜测未公开的配置键。
- 绝不记录凭证。凭证使用宿主秘密存储；测试中使用合成凭证。
- 生产路径中不得使用伪造的成功认证、虚构模型或占位补全结果。
- 新增集成时保留用户已有设置，并跟踪自身拥有的配置以便移除。
- 保持文件与抽象精简。只有在验证接入路径后才添加具体适配器。
- 唯一的编辑器扩展位于 `packages/extension`（包名 `unify-provider-vscode`，Marketplace ID 不可变故保留后缀），同一 VSIX 服务所有支持的编辑器。
- 代码变更后运行 npm run check。随着认证状态、协议转换与工具调用正确性等功能落地，补充相应测试。
