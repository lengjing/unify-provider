# Subscription providers

MVP: implement Codex against the contracts in `../core/provider.ts`.

Before choosing direct OAuth/HTTP or Codex app-server, verify browser authentication, multi-turn caller-owned tools, runtime packaging, and model discovery. Keep Codex-specific protocol and runtime requirements inside this layer.

Future subscriptions, including Claude Code, get separate adapters after their authentication and supported integration mechanisms are investigated. Do not assume they share Codex's OAuth flow or API.
