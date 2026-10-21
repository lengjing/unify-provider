# Unify Provider

Use the AI subscriptions you already have inside your editor's **native** Chat and Agent. The first provider is **Codex** (your ChatGPT plan) through OpenAI's official **Sign in with ChatGPT**; more providers follow behind the same vendor-neutral interface.

- **VS Code**: zero configuration — sign in once, pick a model in Copilot Chat. No API key, URL, port, separate backend, Node.js, or Codex CLI.
- **Trae**: the extension runs a loopback endpoint and generates the configuration for you; paste it once into Trae's custom model settings.

## Requirements

- **VS Code 1.104 or later** or **Trae** (verified with Trae CN 3.4.4), running locally.
- **GitHub Copilot Chat** for the native Chat/Agent interface. Availability of bring-your-own-model (BYOK) features depends on your VS Code version and organization policies; current VS Code documentation does not require a Copilot subscription for BYOK models.
- A **ChatGPT account eligible for Sign in with ChatGPT plan usage**.
- Network access to **auth.openai.com** and **api.openai.com**, plus a browser for sign-in.

## Getting started

1. Install **Unify Provider** in VS Code.
2. Open the Command Palette and run **Unify Provider: Sign in with ChatGPT**.
3. Read the notice, choose **Continue with ChatGPT**, and complete sign-in and authorization in your browser. Agree to using your ChatGPT plan allowance; on first successful sign-in, acknowledge the **You're using your ChatGPT plan** confirmation with **Got it**.
4. In the Chat model picker, select a model under **Unify Provider (ChatGPT plan)**.

**You must select a model once yourself**; the extension cannot select it automatically. Models are discovered from your connected account, not a fixed list.

For the **Copilot harness / Agents window (Agent Host)**, enable the experimental VS Code setting **`chat.agentHost.byokModels.enabled`**. This setting may change or be removed. The Local harness is a separate path. Unify Provider does not change your settings automatically.

## Trae

Trae's native agent does not read VS Code's language-model API, so the extension starts a small OpenAI-compatible endpoint on 127.0.0.1 when it detects Trae.

1. Sign in (status bar → **Continue with ChatGPT**).
2. Status bar → **Local endpoint: copy configuration**. Copy the Base URL (http://127.0.0.1:46117/v1), the API key and a model ID from the list.
3. Trae: **Settings → Models → Add custom model → Custom configuration**. API format **OpenAI Chat Completions**, leave the "full URL" switch off, paste the three values, confirm.
4. In a Builder/Agent conversation, pick the model you added. Trae's **Auto** mode only uses Trae's built-in models.

Notes:

- The key is generated per install and stored in Secret Storage; it is not your ChatGPT credential. **Local Endpoint: Remove Stored Key and Port** deletes it (Trae's own settings are untouched).
- If port 46117 is taken, the endpoint falls back to another port and tells you to update the Base URL.
- Trae composes requests on its servers and relays them through the local agent process, so prompts, tool definitions and model output transit Trae's infrastructure. Latency depends on that relay as well as on OpenAI.

## Commands

Open the Command Palette to use these commands:

| Command | Purpose |
| --- | --- |
| **Unify Provider: Sign in with ChatGPT** | Connect your account, or sign in again after authorization expires or is revoked. |
| **Unify Provider: Disconnect** | Disconnect and delete the saved session from VS Code Secret Storage. |
| **Unify Provider: Manage Unify Provider** | Open account actions: sign in, disconnect, show status, show logs, or Manage usage. |
| **Unify Provider: Show Status** | Show the current connection/account status and a Manage usage action. |
| **Unify Provider: Show Logs** | Open the **Unify Provider** Output channel for safe diagnostics. |
| **Unify Provider: Local Endpoint: Copy Configuration (Trae)** | Start the loopback endpoint if needed and copy Base URL / key / model IDs. |
| **Unify Provider: Local Endpoint: Stop** | Stop the loopback endpoint for this session. |
| **Unify Provider: Local Endpoint: Remove Stored Key and Port** | Delete the generated key and remembered port. |

## Status bar

Click the ChatGPT status bar item to open account actions. Its text indicates:

- **Using ChatGPT plan · account**: connected to the displayed account. Remaining/total quota is shown only when provided by the service; `?` means a value is unknown.
- **ChatGPT: Connecting**: sign-in is in progress.
- **ChatGPT: Disconnected**: no active connection; sign in to discover models.
- **ChatGPT: Sign in again**: authorization needs renewal.
- **Usage limited**: a plan or app usage limit was reached.
- **Ineligible/access denied**: account eligibility or authorization prevents access.
- **Request failed** or **Status unavailable**: check the logs and troubleshooting steps below.

The tooltip and account actions include [**Manage usage**](https://chatgpt.com/settings/usage).

## Troubleshooting

### Models do not appear

Sign in first and check the status bar. Copilot Business/Enterprise administrators can disable BYOK through the **Bring Your Own Language Model Key in VS Code** policy. For the Copilot harness / Agents window, also check `chat.agentHost.byokModels.enabled`.

If models still do not appear, run **Developer: Reload Window**, then reopen the model picker. Older VS Code releases may have different BYOK account restrictions. When not signed in to GitHub, utility models may require separate configuration in VS Code (`chat.utilityModel`, `chat.utilitySmallModel`, or `chat.byokUtilityModelDefault`); selecting a main Chat model does not configure every auxiliary feature.

### Requests fail or the network is unreliable

Run **Unify Provider: Show Logs**, or open **View → Output** and select **Unify Provider**. Check the diagnostic error and connection status before trying again.

Intermittent **`network_error`** errors can indicate a network, proxy, certificate, or gateway problem. When a response has no `content-type`, the extension automatically identifies its format from the body. If it still fails, check your system proxy and VS Code's **`http.proxy`**, **`http.proxySupport`**, and **`http.fetchAdditionalSupport`** settings. An HTTP 200 response alone does not guarantee a successful model response.

When reporting a problem, share only safe diagnostic metadata, not credentials, conversation text, or response bodies.

### Usage limit or access denied

Open [**Manage usage**](https://chatgpt.com/settings/usage) to review your ChatGPT plan and app limits. Usage is shared with other apps using your plan. Limit and eligibility errors are not retried automatically, and reaching a limit does not switch to a paid API method. For access-denied errors, check account eligibility and the authorization you granted.

### Sign in again

Run **Unify Provider: Sign in with ChatGPT** if authorization expired or was revoked. To replace a connected account, **Disconnect** first, then sign in again. You can also revoke this app's authorization in ChatGPT settings.

## Privacy & data

- Credentials are stored in **VS Code Secret Storage**. Disconnect on shared computers to remove the saved session.
- Logs do **not** include tokens or conversation content; diagnostics use safe metadata and error identifiers.
- Model discovery and inference requests go directly to **api.openai.com** from the extension, with no third-party server operated by Unify Provider. Your selected chat context is sent to OpenAI to answer requests.

## Limitations

- The extension cannot automatically select a model in the Chat picker.
- Inline completions, semantic search, and embedding-dependent features do not use this model connection.
- Image input is available only when the selected model supports it. Audio and non-text tool results are not supported.
- **Required tool mode** is not supported; requests requiring it are rejected rather than treated as automatic tool selection.
- Remote SSH OAuth callback forwarding is not supported. Use a local VS Code window; remote and Web environments are outside this extension's scope.

## Disclaimer

Unify Provider is a free, locally running, **MIT-licensed open-source third-party tool**, not an OpenAI product and not endorsed by OpenAI. Sign in with ChatGPT (SIWC) is in preview: APIs, available models, eligibility, and policies may change. Account access cannot be guaranteed.

Requests count toward **your ChatGPT plan's Codex allowance**, shared with other apps. There is no extra charge from Unify Provider and no automatic paid fallback.

## License

[MIT](https://github.com/lengjing/unify-provider/blob/main/LICENSE).
