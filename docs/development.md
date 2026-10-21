# Development

Contributor setup, extension debugging, packaging, and verification live here. The [extension README](../packages/extension/README.md) is user-facing. For scope and roadmap, see [Roadmap](roadmap.md); for compatibility claims and evidence requirements, see [Compatibility](compatibility.md). A successful build or install is not evidence of native Agent compatibility.

## Repository structure and workspaces

The root is a private npm workspace (`packages/*`). Use Node.js 22 or later; the extension development environment previously documented Node.js 24. End users use VS Code's built-in extension host and do not need Node.js or Codex CLI. Extension debugging requires VS Code 1.104 or later.

```text
packages/
  core/                  @unify-provider/core: editor-independent core
    src/core/            Provider contracts, registry, request routing
    src/editors/         Editor integration contracts and target list
    src/providers/       Subscription providers (Codex via SIWC)
    src/transports/      Transports for later compatibility interfaces
    test/
  extension/             unify-provider-vscode: the single editor extension (VS Code LanguageModelChatProvider + Trae loopback route)
    src/                 Extension, host integration, message/event conversion, local endpoint manager
    test/                Unit tests, without the VS Code runtime
    .vscode/             Extension Development Host launch/build task
    l10n/                Runtime translations
  local-endpoint/        @unify-provider/local-endpoint: OpenAI Chat Completions <-> core, loopback HTTP server (Trae)
docs/                    Architecture, compatibility, MVP, risks, development
```

Only the official OpenAI Sign in with ChatGPT (ChatGPT plan usage) open-source client flow is allowed for Codex. Do not reuse the Codex CLI client ID, call `chatgpt.com/backend-api`, or depend on Codex CLI/app-server. Keep the provider interfaces neutral and the project MIT-licensed, free, open source, and locally hosted. See [AGENTS.md](../AGENTS.md) and [Risks](risks.md).

## Setup and automated checks

From the repository root:

```sh
npm install
npm run check
```

The root `check` script runs workspace typechecking, tests, and builds, skipping scripts absent from a workspace. GitHub Actions (`.github/workflows/ci.yml`) runs the same `npm run check` on Ubuntu and Windows with Node 22 and 24 for every push to `main`, every pull request and every `v*` tag. Only a `v*` tag packages the VSIX: the root and every workspace package must share one version and the tag must equal `v` + that version, after which the VSIX is uploaded as the `unify-provider-vsix` artifact and attached to a GitHub Release with generated notes. It does not run real browser sign-in or VS Code end-to-end verification. Use synthetic credentials in tests and never record real credentials.

## F5 debugging

1. **Open `packages/extension` as a separate folder in VS Code.** The package's `.vscode/launch.json` assumes `${workspaceFolder}` is the extension package, not the repository root.
2. Select **Unify Provider Extension** and press **F5**. The `extensionHost` launch passes `--extensionDevelopmentPath=${workspaceFolder}` and opens an Extension Development Host.
3. Its `preLaunchTask`, **build extension**, is defined in `.vscode/tasks.json`. It runs `npm run build` with the extension folder as the working directory; there is no problem matcher.
4. Set breakpoints in `src/*.ts`. `outFiles` points at `dist/**/*.js`, and esbuild sourcemaps support debugging.
5. After changes, run `npm run build` in the extension folder and restart debugging, or run `npm run watch` in another terminal to rebuild while editing. Restart/reload the host to use the new bundle.

## Versioning and releases

All packages (root, `core`, `extension`, `local-endpoint`) move together. Bump them in one step:

```sh
npm run version:bump -- patch          # or minor / major / 1.2.3; edits package.json files and the lockfile
npm run version:bump -- patch --tag    # additionally commits "vX.Y.Z" and creates an annotated tag (requires a clean tree)
git push && git push origin vX.Y.Z     # the tag triggers the release job in CI
```

`scripts/version.mjs` rewrites only the `"version"` line of each manifest, so formatting is preserved; it refuses to run if the packages are already out of sync.

## esbuild and VSIX packaging

esbuild bundles the extension into CJS. The only external module is `vscode`; the extension has no runtime npm dependencies. `@unify-provider/core` and `@unify-provider/local-endpoint` are workspace development dependencies; both `esbuild.mjs` (`alias`) and `tsconfig.json` (`paths`) resolve them to **source**, so the extension bundle never depends on workspace build order or stale `dist` output.

At the repository root:

```sh
npm run package --workspace unify-provider-vscode
```

This invokes `vsce package --no-dependencies`; the `vscode:prepublish` hook first runs the esbuild build. The package script sets GitHub base URLs for README content and images. `.vscodeignore` excludes dependencies, source, tests, debug configuration, build configuration, and existing VSIX files. The VSIX includes the MIT LICENSE and the English user README; the former extension `README.zh-CN.md` has been removed. The root Chinese README is retained.

The extension is published under the Marketplace publisher `gamstek` (`publisher` in `packages/extension/package.json`); the extension ID is therefore `gamstek.unify-provider-vscode`. Marketplace IDs are immutable, so the package `name` keeps the historical `-vscode` suffix even though the directory is `packages/extension` and the extension serves other editors too. The VSIX must be uploaded from an account that owns that publisher.

### Install a local VSIX

For the current version, from the repository root:

```sh
code --install-extension packages/extension/unify-provider-vscode-0.1.0.vsix
# Trae CN (Windows)
& "$env:LOCALAPPDATA\Programs\Trae CN\bin\trae-cn.cmd" --install-extension packages/extension/unify-provider-vscode-0.1.0.vsix
```

Alternatively, use **Extensions: Install from VSIX...** in VS Code. Adjust the filename when the version changes. Verify install, upgrade, and uninstall behavior independently of packaging success.

## Local endpoint (Trae route)

`packages/local-endpoint` is a plain Node HTTP server over `@unify-provider/core`; it has no VS Code dependency and is unit-tested with real loopback sockets (`npm test --workspace @unify-provider/local-endpoint`). The extension's `src/local-endpoint.ts` owns the lifecycle:

- Starts automatically when `vscode.env.appName` contains "Trae"; otherwise only on demand from the manage menu.
- Key: `context.secrets` `unifyProvider.localEndpoint.token`; port: `globalState` `unifyProvider.localEndpoint.port` (preferred 46117, falls back to an OS port on `EADDRINUSE` and warns). **Local Endpoint: Remove Stored Key and Port** deletes both; Trae's own settings are never written.
- "Copy configuration" is a QuickPick; opening Trae's model settings uses `workbench.action.openTraeSettings` when registered and falls back to `workbench.action.openSettings`.
- Request logs include `queueMs` / `firstOutputMs` / `upstreamMs` to separate endpoint overhead from provider latency. Trae adds its own relay latency (server → tunnel → local agent → endpoint) that is not visible here.

To re-verify Trae after a Trae update, follow the per-editor steps in [Compatibility](compatibility.md) and record the Trae version, the request shape observed at the endpoint, and a native-agent tool round-trip.
## Core interface dependency

The extension depends on `createCodexProvider({ host, agentName: 'Unify Provider' })`, exported by `@unify-provider/core`, returning a real `SubscriptionProvider` with `id === 'codex'`. The activation path also supplies a safe logger. Core owns SIWC, connection restoration/token refresh, model discovery, inference, and disconnection.

Activation uses a dynamic import and runtime checks. If the factory export is missing, it reports **Core not ready** and registers no fake models. An incorrect provider ID is also rejected. Rebuild and reload after core is ready; compilation alone does not establish operational sign-in.

## Internationalization

- `packages/extension/package.nls.json` contains default English manifest strings: extension display name/description, provider display name, and command titles. `package.nls.zh-cn.json` supplies Simplified Chinese translations for those `%key%` references in `package.json`.
- Runtime UI uses English source strings through `vscode.l10n.t(...)`. The manifest's `l10n: "./l10n"` points at runtime translations, currently `l10n/bundle.l10n.zh-cn.json`; there is no separate default English bundle.
- Keep translated strings, placeholders, and required SIWC wording in sync. Removing the extension Chinese README does not remove Chinese UI localization.

## Logs and response diagnostics

**Unify Provider: Show Logs** opens the **Unify Provider** log Output channel; it is also available through **View → Output**. Do not log tokens, conversation content, or raw response bodies. Unknown core exceptions produce safe generic notifications, not raw server responses. Stream events retain `code`/`message`/`retryable` for internal conversion; quota and eligibility errors receive safe UI text.

### HTTP 200 without a Responses stream

When `content-type` is absent, the response body is sniffed. If processing still fails, the log's `sniff` field identifies the body type (`sse`, `json`, `html`, or `unknown`) without exposing contents. Intermittent `network_error` failures should also be investigated at the network/proxy layer.

Inspect the non-SSE metadata: `contentType`, `contentEncoding`, `contentLength`, `transferEncoding`, and `bodyNull`. HTTP 200 alone does not mean streaming succeeded. The official `stream:true` contract requires `text/event-stream`; a completed JSON Response is tolerated and converted to completion events, while failed/incomplete JSON responses remain errors. Only allowlisted JSON status/error identifiers are logged, never output text.

If the response is not `text/event-stream`, check VS Code's `http.proxy`, `http.proxySupport`, and `http.fetchAdditionalSupport` settings and the system proxy. The extension uses host fetch, which VS Code may patch for proxy/certificate support. HTML or an unexpected response type may indicate proxy/gateway interception. Share only safe diagnostic metadata when reporting issues, never credentials or response bodies. Model discovery is cached for ten minutes in core and ten seconds in the extension, invalidated on connection changes.

## Manual verification checklist (pending)

Record the VS Code version, OS, core version, steps, and evidence in accordance with [Compatibility](compatibility.md#每端验证步骤). Test Local and Copilot harnesses separately.

- [ ] F5 debugging; VSIX installation, upgrade, and uninstall.
- [ ] Real SIWC browser sign-in: first-use risk notice/ChatGPT plan confirmation appears only once; account and known quota are correct in the status bar; notifications/logs contain no credentials.
- [ ] Signed-out silent model discovery produces no dialog or models. Sign-in refreshes the picker; record any window reload requirement. Select a model manually.
- [ ] Local Agent multi-turn tool calls: search code → edit files → run tests in the terminal → fix issues. Tool IDs/results round-trip correctly, and VS Code executes the tools.
- [ ] Copilot / Agent Host: enable experimental `chat.agentHost.byokModels.enabled` and repeat the complete tool round-trip independently.
- [ ] Streaming text, parallel tool arguments, and image input. Stop interrupts requests without executing incomplete tools.
- [ ] Connection restoration after restart, automatic refresh on token expiry, and a sign-in prompt after revocation/invalidation.
- [ ] 429/quota exhausted and 403/ineligible: clear messages, no automatic retries or sign-in loops, and a working **Manage usage** link (`https://chatgpt.com/settings/usage`).
- [ ] Disconnect removes models and deletes the session in VS Code Secret Storage; the extension remains disconnected after restart. Existing user settings remain unchanged. Authorization can also be revoked in ChatGPT settings.

The user flow needs no key, URL, port, or separate backend. First successful sign-in confirms ChatGPT plan usage; allowance is shared with other apps, with no extra charge or automatic paid fallback. Include those notices in UI review.

## Known limitations and unverified items

The notes below preserve the former extension README's development caveats. They are not a new verification report. In particular, its role-conversion and model-budget notes describe that documentation snapshot and must be rechecked against the current source and tests before being treated as current implementation behavior.

- No public API automatically selects a model; users must select once. Immediate picker visibility and any reload requirement remain unverified.
- Copilot Agent Host requires experimental `chat.agentHost.byokModels.enabled`, which may change or be removed. The extension does not write settings automatically. Verify the Local harness separately.
- Business/Enterprise policies may disable BYOK. Older/current stable version differences remain unverified. BYOK does not cover inline completion or semantic search. Utility models may require separate configuration without GitHub sign-in.
- Remote SSH with a remote extension host needs `asExternalUri` forwarding for the `127.0.0.1` OAuth callback; this is **not implemented**. Prefer a local UI host; remote/Web support is not promised.
- The former README noted that the 1.104 API has only User/Assistant roles and described the converter as accepting system/developer only as explicitly named roles, never inferring system instructions from ordinary user messages. Recheck role handling against current conversion tests. Newer `LanguageModelDataPart` images follow the documented structure. Audio and non-text tool results, including PromptTsx, are explicitly rejected rather than silently dropped.
- Core has no tool-selection mode field: `toolMode Required` is explicitly rejected, never silently treated as Auto. Custom `modelOptions` are not forwarded, to avoid unsupported SIWC fields.
- The stable API has no reasoning/provider-state part. Reasoning deltas and opaque state are not emitted as text. Cross-turn continuation requiring opaque reasoning state needs end-to-end verification.
- Character count divided by four, rounded up, is a budget estimate, not a tokenizer; it may underestimate CJK/images. Input capacity is `contextWindow - maxOutputTokens`. Only core models declared to support tools are exposed, avoiding overstated Agent capabilities.
- The former README recorded a core catalog without published output limits: `maxOutputTokens: 0` meant unknown and was mapped unchanged, without inventing a limit. It identified VS Code's acceptance of zero output capacity and budget/model picker behavior as a potential blocker. Current automated checks include model-limit resolution and positive-budget tests; recheck the current mapping and verify real VS Code behavior rather than assuming that historical zero-limit path still applies.
- Native VS Code notification buttons cannot reproduce full brand logos/layouts. The extension uses **Continue with ChatGPT**, **Got it**, **Using ChatGPT plan**, and **Manage usage**, but visual brand compliance needs manual review.

Real sign-in, native Agent, cancellation, restart, refresh/revocation, quota, remote, and UI behavior remain unverified in practice. Extension unit tests cover message/event conversion without the VS Code runtime and are not compatibility evidence. Packaging/check results must not be presented as completing this checklist.

Qoder IDE and Cursor: **Not supported, pending vendor support**. Trae is supported through the loopback endpoint (one-time paste); the new Qoder desktop app is a later target on the same route.
