# @unify-provider/local-endpoint

OpenAI-compatible loopback endpoint that exposes `@unify-provider/core` providers to editors whose native agent can only call an HTTP model API (currently Trae). The extension owns its lifecycle: it starts the server, generates and stores the bearer key, and shows the user what to paste.

## Guarantees

- Binds `127.0.0.1` only and drops non-loopback connections.
- Every request needs `Authorization: Bearer <key>` (constant-time comparison). The key is at least 16 characters and is supplied by the host.
- Logs record method, path, status, model ID, message/tool counts and timings — never headers, bodies, prompts or output.
- Nothing is faked: a provider error or an incomplete upstream stream is reported as an error, not as an answer.

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /v1/models` | Models from the connected provider (`/models` without the prefix also works). 503 `not_connected` when the user has not signed in, 401 when re-authentication is needed. |
| `POST /v1/chat/completions` | Chat Completions → core `CompletionRequest`; core events → `chat.completion.chunk` SSE or a single `chat.completion`. |

Supported request features: `system`/`developer`/`user`/`assistant`/`tool` messages, `tool_calls`, `image_url` **data URLs** (remote URLs are rejected), `tools` as function tools, `tool_choice: auto|none`, `reasoning_effort` when the model supports it, `stream`.
Explicitly rejected with 400: `tool_choice: required`/specific, `n > 1`, non-text `response_format`, legacy `functions`. Sampling fields (`temperature`, `top_p`, `max_tokens`) are ignored because the Codex preview rejects them upstream.

Streaming output: role chunk, `content` / `reasoning_content` / indexed `tool_calls` deltas, a final chunk with `finish_reason` and `usage`, then `data: [DONE]`. Errors after headers were sent arrive as a `{"error": …}` frame without `[DONE]`.

## Usage

```ts
import { startLocalEndpoint } from '@unify-provider/local-endpoint';

const endpoint = await startLocalEndpoint({ registry, providerId: 'codex', token, port: 46117, logger });
console.log(endpoint.url); // http://127.0.0.1:46117
await endpoint.close();
```

Verification evidence for Trae lives in [docs/compatibility.md](../../docs/compatibility.md).
