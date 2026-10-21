[English](README.md) | 简体中文

# Unify Provider

**把你已经在付费的 AI 订阅，接进编辑器自带的 Chat / Agent——一个插件，多种提供者，不用粘贴 API Key 和 URL。**

Unify Provider 是一个开源、完全在本机运行的连接器。它用模型厂商的官方流程完成登录，把凭证保存在编辑器的安全存储里，再把厂商的模型暴露给编辑器**原生** Agent（不是另开一个聊天面板）。编辑器继续负责它擅长的事——上下文、工具执行、权限、diff 审阅——Unify Provider 只负责供模型。

## 支持的编辑器

| 编辑器 | 体验 | 状态 |
| --- | --- | --- |
| **VS Code**（Copilot Chat / Agent） | 零配置：安装、浏览器登录一次、在模型选择器里选模型 | 可用 |
| **Trae** | 粘贴一次：插件启动一个回环端点并替你生成 Base URL / 密钥 / 模型 ID，粘到 *设置 → 模型 → 添加自定义模型* 即可 | 可用（已在 Trae CN 3.4.4 验证） |
| Qoder 新版桌面应用 | 与 Trae 相同的回环端点路线 | 计划中 |
| Qoder IDE、Cursor | 原生 Agent 没有本地模型入口 | 不支持，待厂商开放 |

只有在录得真实的原生 Agent 工具往返之后才声明兼容；每一行背后的证据见 [docs/compatibility.md](docs/compatibility.md)。

## 提供者

| 提供者 | 连接方式 | 状态 |
| --- | --- | --- |
| **Codex**（ChatGPT Plus/Pro/Team 订阅） | OpenAI 官方 *Sign in with ChatGPT*（浏览器 OAuth）；推理直连 `api.openai.com` | 可用 |
| Claude | 仅 API Key / Amazon Bedrock / Google Vertex——Anthropic 不允许第三方使用 Pro/Max 订阅 | 计划中 |
| 其它 | 通过 `@unify-provider/core` 的中立提供者契约接入 | 计划中 |

提供者是接在厂商中立接口后面的插件；核心与编辑器适配器都不绑定任何一家模型厂商。

## 快速开始

### VS Code

1. 安装扩展（Releases 里的 `unify-provider-*.vsix`，或按下文自行构建）。
2. 命令面板运行 **Unify Provider: 登录 ChatGPT**，在浏览器里完成登录。
3. 打开 Copilot Chat，在模型选择器里选 **Unify Provider** 下的模型。

就这些——模型选择在重启后保留，令牌自动续期。

### Trae

1. 安装同一个 VSIX：`trae-cn --install-extension unify-provider-*.vsix`（或 *扩展 → 从 VSIX 安装*），然后重载窗口。
2. 点右下角状态栏 → **Continue with ChatGPT** 完成登录。
3. 状态栏 → **本地端点：复制配置**，依次复制三项。
4. 在 Trae：*设置 → 模型 → 添加自定义模型 → 自定义配置*，API 格式选 **OpenAI Chat Completions**，粘贴 Base URL（`http://127.0.0.1:46117/v1`）、API 密钥和一个模型 ID。"完整 URL"开关保持关闭。

端点只监听 `127.0.0.1`、要求生成的密钥、随 Trae 自动启动。请注意：Trae 的 Agent 编排在 Trae 服务端完成，提示词、工具定义和模型输出会经其服务器中转后再到达本地端点（详见 [docs/compatibility.md](docs/compatibility.md) 的 Trae 一节）。Trae 的 *Auto* 模式不使用自定义模型。

## 工作原理

```text
 编辑器原生 Agent ──▶ 编辑器适配器 ──▶ 核心（注册、路由、流式） ──▶ 提供者 ──▶ 厂商 API
   VS Code：vscode.lm LanguageModelChatProvider（进程内）
   Trae：   由扩展托管的 OpenAI 兼容回环端点
```

- **`packages/core`** — 提供者契约（`SubscriptionProvider`）、注册表、消息/工具/流式模型，以及 Codex 提供者（Sign in with ChatGPT、令牌刷新、Responses API 转换）。
- **`packages/extension`** — 唯一的编辑器扩展。在 VS Code 注册语言模型提供者；在 Trae 额外启动回环端点并提供"复制配置"流程。
- **`packages/local-endpoint`** — OpenAI Chat Completions ↔ 核心的转换，以及回环 HTTP 服务（流式、工具调用、图片输入、取消）。

## 隐私与安全

- 凭证保存在编辑器的安全存储，不写入设置文件或仓库；断开连接即删除。
- 日志只有状态码、耗时和标识符——绝不含令牌、提示词、工具参数或模型输出。
- 不存在 Unify Provider 的服务器。Codex 请求从你的机器直达 `api.openai.com`。Trae 路线经由 Trae 自己的服务器中转是 Trae 的设计而非我们的；本地端点会忽略且不记录收到的厂商内部请求头。
- 本地端点绑定 `127.0.0.1`，每个请求都用安装级密钥鉴权，拒绝抓取远程图片 URL。

## 限制

- 编辑器必须提供原生入口（语言模型 API 或自定义模型设置）。我们不修改编辑器二进制，也不依赖未公开协议。
- 行内补全、嵌入向量以及厂商专属的"自动选模"模式不走这条连接。
- Codex 的 Sign in with ChatGPT 处于预览期：可用模型、资格和政策可能变化；用量计入你的 ChatGPT 订阅额度并与其它应用共享，不会自动切到付费 API。
- 不支持强制工具调用模式、非文本工具结果、远程 SSH 的 OAuth 回调转发。

## 开发

需要 Node.js 22+ 与 npm。

```sh
npm install
npm run check                                 # 对每个包执行类型检查 + 测试 + 构建
npm run package --workspace unify-provider    # 生成 VSIX 到 packages/extension/
```

调试、打包与人工验证清单见 [docs/development.md](docs/development.md)。

## 文档

[架构](docs/architecture.md) · [兼容性与证据](docs/compatibility.md) · [风险与合规](docs/risks.md) · [开发](docs/development.md) · [路线图](docs/roadmap.md)

## 许可与声明

[MIT](LICENSE)。Unify Provider 是独立的开源工具，与 OpenAI、字节跳动、微软或任何编辑器/模型厂商无关，亦未获其背书。Sign in with ChatGPT 仅面向开源、本地托管的应用；本项目将保持开源、免费、仅本机运行。
