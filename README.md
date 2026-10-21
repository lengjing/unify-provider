English | [简体中文](README.zh-CN.md)

# Unify Provider

**Use the AI subscriptions you already pay for inside your editor's native Chat and Agent — one extension, multiple providers, no API keys or URLs to paste.**

Unify Provider is an open-source, locally running connector. It signs you in to a model provider with the provider's official flow, keeps the credentials in your editor's secure storage, and exposes the provider's models to the editor's **built-in** agent (not a separate chat panel). The editor keeps doing what it does best — context, tool execution, permissions, diff review — and Unify Provider only supplies the model.

## Supported editors

| Editor | Experience | Status |
| --- | --- | --- |
| **VS Code** (Copilot Chat / Agent) | Zero configuration: install, sign in once in the browser, pick a model in the chat model picker | Available |
| **Trae** | One-time paste: the extension runs a loopback endpoint and generates the Base URL / key / model ID for you; paste them once into *Settings → Models → Add custom model* | Available (verified on Trae CN 3.4.4) |
| Qoder desktop app | Same loopback route as Trae | Planned |
| Qoder IDE, Cursor | Their native agents offer no local model route | Not supported until the vendor opens one |

Compatibility is claimed only after a real native-agent tool round-trip has been recorded; see [docs/compatibility.md](docs/compatibility.md) for the evidence behind each row.

## Providers

| Provider | How you connect | Status |
| --- | --- | --- |
| **Codex** (ChatGPT Plus/Pro/Team plan) | OpenAI's official *Sign in with ChatGPT* (browser OAuth); inference goes straight to `api.openai.com` | Available |
| Claude | API key / Amazon Bedrock / Google Vertex only — Anthropic does not permit third-party use of Pro/Max subscriptions | Planned |
| Others | Via the neutral provider contract in `@unify-provider/core` | Planned |

Providers are plugins behind a vendor-neutral interface; nothing in the core or the editor adapters is tied to one model vendor.

## Quick start

### VS Code

1. Install the extension (`unify-provider-vscode-*.vsix` from Releases, or build it yourself — see below).
2. Run **Unify Provider: Sign in with ChatGPT** from the Command Palette and finish sign-in in your browser.
3. Open Copilot Chat, open the model picker, and choose a model under **Unify Provider**.

That is all — the model stays selected across restarts and tokens refresh automatically.

### Trae

1. Install the same VSIX: `trae-cn --install-extension unify-provider-vscode-*.vsix` (or *Extensions → Install from VSIX*), then reload the window.
2. Click the status bar item → **Continue with ChatGPT** and sign in.
3. Status bar → **Local endpoint: copy configuration**. Copy the three entries it offers.
4. In Trae: *Settings → Models → Add custom model → Custom configuration*, API format **OpenAI Chat Completions**, and paste the Base URL (`http://127.0.0.1:46117/v1`), the API key and a model ID. Leave the "full URL" switch off.

The endpoint listens on `127.0.0.1` only, requires the generated key, and starts automatically with Trae. Note that Trae's agent orchestration runs on Trae's servers: prompts, tool definitions and model output are relayed through them before reaching the local endpoint (details in the Trae section of [docs/compatibility.md](docs/compatibility.md)). Trae's *Auto* mode does not use custom models.

## How it works

```text
 editor native agent ──▶ editor adapter ──▶ core (registry, routing, streaming) ──▶ provider ──▶ vendor API
   VS Code: vscode.lm LanguageModelChatProvider (in-process)
   Trae:    OpenAI-compatible loopback endpoint managed by the extension
```

- **`packages/core`** — provider contract (`SubscriptionProvider`), registry, message/tool/stream model, and the Codex provider (Sign in with ChatGPT, token refresh, Responses API conversion).
- **`packages/extension`** — the single editor extension. In VS Code it registers a language-model provider; in Trae it additionally starts the loopback endpoint and offers the copy-configuration flow.
- **`packages/local-endpoint`** — OpenAI Chat Completions ↔ core conversion and the loopback HTTP server (streaming, tool calls, image input, cancellation).

## Privacy and security

- Credentials live in the editor's secret storage; nothing is written to settings files or the repository. Disconnect removes them.
- Logs contain status codes, timings and identifiers — never tokens, prompts, tool arguments or model output.
- No Unify Provider server exists. Codex requests go from your machine to `api.openai.com`. For Trae, the relay through Trae's own servers is Trae's design, not ours; the local endpoint ignores and never logs the vendor-internal headers it receives.
- The local endpoint binds `127.0.0.1`, authenticates every request with a per-install key, and refuses to fetch remote image URLs.

## Limitations

- Editors must offer a native route (a language-model API or a custom-model setting). We do not patch editor binaries or rely on undocumented protocols.
- Inline completions, embeddings and vendor-specific "auto" model modes are outside this connection.
- Codex via Sign in with ChatGPT is a preview program: available models, eligibility and policies may change, and usage counts against your ChatGPT plan allowance shared with other apps. There is no automatic fallback to paid API billing.
- Required tool mode, non-text tool results and remote-SSH OAuth callback forwarding are not supported.

## Development

Node.js 22+ and npm.

```sh
npm install
npm run check                                 # typecheck + tests + build for every package
npm run package --workspace unify-provider-vscode  # build the VSIX into packages/extension/
```

See [docs/development.md](docs/development.md) for debugging, packaging and the manual verification checklist.

## Documentation

[Architecture](docs/architecture.md) · [Compatibility and evidence](docs/compatibility.md) · [Risks and compliance](docs/risks.md) · [Development](docs/development.md) · [Roadmap](docs/roadmap.md)

## License and disclaimer

[MIT](LICENSE). Unify Provider is an independent open-source tool, not affiliated with or endorsed by OpenAI, ByteDance, Microsoft or any editor or model vendor. Sign in with ChatGPT is only offered to open-source, locally hosted applications; this project will stay open source, free of charge and local-only.
