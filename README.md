English | [简体中文](README.zh-CN.md)

# Unify Provider

An open-source, locally running AI subscription connector that lets your editor's **native** Chat/Agent use your existing Codex (ChatGPT subscription) models, without manually entering API keys, URLs, ports, or JSON.

> This project is open source under the [MIT license](LICENSE). Codex integration uses OpenAI's "Sign in with ChatGPT — ChatGPT plan usage" flow, which is available only to open-source, locally hosted apps (see [docs/risks.md R3](docs/risks.md)). The project must therefore remain open source, free of charge, and not remotely hosted.

## Goals and support strategy (Plan A)

| Tier | Target | Experience | Status |
| --- | --- | --- | --- |
| Zero configuration (MVP) | VS Code (Copilot Chat, Local/Copilot harnesses) | Install the extension → sign in to ChatGPT in the browser → select a Codex model once in the model picker | In progress |
| Secondary experience (later) | New Qoder desktop app, Trae | A plugin/local program manages a local OpenAI-compatible service; users enter Base URL / Key / Model ID once in editor settings | Not started; outside the MVP |
| Not supported, pending vendor support | Qoder IDE, Cursor | Not feasible through public mechanisms: Qoder IDE has no custom Base URL; Cursor sends BYOK requests from its servers | No development planned |

See [docs/compatibility.md](docs/compatibility.md) for the rationale and evidence. The new Qoder app and Trae still require traffic capture to confirm that requests originate locally; no support is claimed before verification. The Copilot harness requires the experimental `chat.agentHost.byokModels.enabled` setting; Local and Copilot must be verified separately.

**Codex integration path**: use only OpenAI's official Sign in with ChatGPT (SIWC) open-source client flow—dynamic registration, PKCE, a `127.0.0.1` callback, and the `chatgpt.tokens.use.direct` scope, with inference sent directly to `https://api.openai.com/v1/responses`; do not reuse the Codex CLI client_id, call `chatgpt.com/backend-api`, or depend on Codex CLI/app-server (see [docs/risks.md](docs/risks.md) for comparisons and compliance evidence).

**Claude**: Claude Pro/Max subscriptions are not integrated (explicitly prohibited by Anthropic; see [docs/risks.md R5](docs/risks.md)). Any future Claude provider will use only officially permitted methods such as user-supplied API keys / Bedrock / Vertex.

## Current status

Completed: product scope, feasibility and compliance research, core interfaces and scaffolding (provider contracts, registry, request routing, and editor integration contracts).

In progress: the Codex (SIWC) provider in core and the VS Code `LanguageModelChatProvider` extension. **No installable extension has been released, and VS Code end-to-end verification is incomplete.** See [docs/mvp.md](docs/mvp.md).

## Target experience (VS Code)

1. Install the extension.
2. Click connect to open ChatGPT sign-in and authorization in the browser.
3. Return automatically to the editor, where models appear in the Chat model picker; select a Codex model once (VS Code remembers it).
4. Restore the connection on later launches and refresh access tokens automatically; show a clear message and sign-in entry point when quota is exhausted or authorization is revoked.

## Development

Development requires Node.js 22+ and npm; end users should not need to install a development runtime or run commands.

```sh
npm install
npm run check
```

## Structure

```text
packages/
  core/                  @unify-provider/core: editor-independent core
    src/core/            Provider contracts, registry, request routing
    src/editors/         Editor integration contracts and target list
    src/providers/       Subscription providers (Codex via SIWC, in progress)
    src/transports/      Transports such as local compatibility interfaces (later)
    test/
  vscode-extension/      VS Code: LanguageModelChatProvider integration (in progress)
  local-endpoint/        Plugin-managed local OpenAI-compatible service for secondary targets only (later; not in MVP)
docs/
  architecture.md        Architecture and three-tier support strategy
  compatibility.md       Editor integration feasibility and evidence
  mvp.md                 MVP scope, acceptance criteria, and implementation checklist
  risks.md               Compliance and platform risks (SIWC, Claude restrictions, OAuth security)
```

Documentation: [Architecture](docs/architecture.md) · [Compatibility](docs/compatibility.md) · [MVP](docs/mvp.md) · [Risks](docs/risks.md).
