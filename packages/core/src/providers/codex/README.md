# Codex / ChatGPT plan usage（SIWC preview）

仅使用 OpenAI 官方开源、本地客户端流程，无 client secret、CLI 或 app-server 依赖。`agentName` 必须是真实且稳定的产品名；宿主负责官方按钮、首次 “You're using your ChatGPT plan” 确认、使用中指示与 [Manage usage](https://chatgpt.com/settings/usage) 链接。

```text
SecretStorage host-id（首次 UUIDv4）
  → 127.0.0.1 随机端口 /auth/callback + state/nonce/PKCE（5 分钟或取消关闭）
  → auth.openai.com authorize（首次 dynamic_agent_client + agent_name_hint）
  → callback issued oaiapp_… client-id → token exchange（相同 redirect/resource）
  → granted scope + RS256/JWKS + iss/aud/nonce/exp/sub 校验 → SecretStorage
  → api.openai.com/v1/models → /responses（HTTP/SSE，无自动重试或计费回退）
  → 到期前 60 秒去重刷新 → 原子替换 token 集
```

## 持久化键（均由 AuthHost.secrets 管理）

| 键 | 内容 / 生命周期 |
| --- | --- |
| `codex.siwc.host-id` | 每个宿主一个 `urn:uuid:…`，重启、登出不变 |
| `codex.siwc.client-id` | 回调签发的注册 ID；即使代码交换失败也保留；后续登录不带 name hint |
| `codex.siwc.registration` | 经验证的 subject/clientId/accountLabel 映射；登出保留 |
| `codex.siwc.tokens` | access/refresh/id tokens、scopes、expiresAt；刷新整条写入；认证失效与登出删除 |

## 错误与状态

| 错误 | 可重试 | 状态 / 操作 |
| --- | --- | --- |
| `subscription_sharing_usage_limit_exceeded` | 否 | 保持 connected，附 error/quota；只保留服务端确实提供的额度字段，未知单位 `unknown`；引导 Manage usage，不猜重置时间 |
| `subscription_sharing_user_not_eligible` | 否 | 保持身份连接，附 error；说明资格/工作区限制，不循环 OAuth |
| `subscription_sharing_unsupported_capability` / `subscription_sharing_route_not_supported` | 否 | connected.error；修正请求/路由 |
| `chatpass_v2_scope_not_authorized` / `chatpass_v2_invalid_authorization_context` | 否 | connected.error；检查授权配置，不自动再次登录 |
| `subscription_sharing_invalid_user`、HTTP 401、终止 refresh 错误（如 `invalid_grant`） | 否 | reauthentication-required；删 token 集，保留注册和主机 |
| `subscription_sharing_usage_unavailable` / `subscription_sharing_user_unavailable`、HTTP 5xx | 是 | 保留凭证；本提供者不自动重试，由宿主限定退避策略 |
| `response.incomplete` / 流提前结束 | 否 / 是 | error 而非伪成功 finish |
| 未收录的模型 slug / 家族 | — | 输出预算退回 `model-limits.ts` 中最小已验证值（当前 128,000）；这是保守的编辑器预算，不代表该未知模型的真实上限 |
| 缺失 `context_window` / 窗口不大于输出上限 | — | 缺失时使用匹配模型、家族或保守条目的文档窗口；输出预算夹取到 `contextWindow - 1`，确保输入/输出预算均为正；非整数或小于 2 的窗口拒绝目录 |

未知错误使用安全的 HTTP/通用代码；不回显上游诊断、code 参数、授权 URL 或凭证。取消抛出 AbortSignal 原因，不再 yield 事件。登出发现官方 revocation_endpoint 并尝试撤销，即使失败仍清本地，并明确报告远端未确认。

## 协议与预览限制

完整历史放 input；system 改 developer；图片为 data URL；工具为 `unify` namespace 中的 function tools（由编辑器执行），历史 function_call/function_call_output 对应调用 ID。`provider-state` 仅回传 Codex reasoning 不透明项，请求 encrypted reasoning 以便无服务器存储的多轮延续。固定 store:false、stream:true；仅允许构造的字段，忽略任意 providerOptions，绝不发送 temperature、max_output_tokens、previous_response_id 等禁用字段或 hosted tools。目录按 visibility/list 与 supported_in_api 过滤，保持顺序；仅使用服务端实际返回的模型，不从静态上限表添加模型。

## 模型 token 上限与维护

SIWC `/v1/models` 不返回输出 token 上限，因此使用 [OpenAI 官方模型文档](https://developers.openai.com/api/docs/models) 的公开数据，而不是上报 0。`model-limits.ts` 的 `modelLimits` 保存每个 slug 的 `maxOutputTokens`、`contextWindow`、`source` 与 `verifiedAt`。2026-10-20 核对的八个基础模型（GPT-5.5、GPT-5.6 Luna/Sol/Terra、GPT-6 Astra/Luna/Sol、GPT-6.1 Sol）均公开 128,000 max output tokens、1,050,000 context window；具体来源见每条 `source`（URL 加 `.md` 可读取纯文本）。

匹配先精确，再按最长的 `slug + "-"` 前缀，支持日期快照，如 `gpt-6.1-sol-2026-xx`；不把 `gpt-6.1` 当作 `gpt-6`。官方目录未单列 `-fast` slug，按任务决策映射到基础模型的相同数值，来源/核对日期沿用基础模型；这是派生映射，不是文档对该 slug 的单独声明（另见 [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)）。`resolveMaxOutputTokens` 对无法匹配的 slug 返回 `undefined`；提供者随后仅对已收录的精确代际家族（5.5、5.6、6、6.1）使用家族中最小已验证输出值，连家族也未知时使用全表最小已验证值。家族/全表回退均不声称未知模型已获文档验证。

`context_window` 优先采用服务端值，缺失或 null 时才采用上述文档窗口。输出预算必要时下调，为输入至少保留 1 token；不会扩大服务端窗口。VS Code 现有 `contextWindow - maxOutputTokens` 因而不会产生负数或 0。这些是宿主预算元数据，仍不向 SIWC 推理请求发送 `max_output_tokens`；订阅实际限制以服务端为准。

更新流程：重新访问各模型的 `source`（或 `.md`），核对 max output tokens 与 context window 后修改对应 `documentedModels` 数据；将该条目传给 `documented` 的 `verifiedAt` 更新为实际核对日（当前相同日期仅表示本次核对，不应在未核对时机械刷新其他条目）。重新确认 `-fast` 是否已独立列出；若有，改为它自身的数值、来源与日期。新增家族须先收录官方文档确认的基础模型；同步本节与回归测试，运行根目录 `npm run check`。目录未公布上限不意味着可以根据测试数据或名字编造上限。

## 尚未实现 / 真实账号验证

当前契约只有一个活动账户，未实现多账户/工作区选择、跨进程 refresh 锁（仅同 provider 实例去重）、无权限的身份-only 登录、强制再次同意权限、WebSocket、文件/custom/hosted tools、自动退避与撤销失败重试。Remote/SSH 的 loopback 浏览器路由、实际动态注册资格、namespace 工具名称与往返、加密 reasoning、多轮额度错误/目录行为需真实账户验证。测试仅用合成 RSA/JWT/JWKS 和注入 fetch，不访问公网。UI/UX 由编辑器宿主实现。
