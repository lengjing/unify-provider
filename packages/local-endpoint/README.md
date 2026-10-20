# @unify-provider/local-endpoint

插件托管的本地兼容服务包占位，待 `docs/compatibility.md` 验证后实现。

只有确认某个目标编辑器的原生 Agent 能够使用并被自动配置为调用本地 HTTP 端点后，才实现此包。实现时仅绑定回环地址、校验本地调用凭证，并由插件负责启动、发现与关闭。
