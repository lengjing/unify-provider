import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompletionEvent, CompletionRequest, ConnectionState, SubscriptionProvider } from '@unify-provider/core';
import { ProviderRegistry } from '@unify-provider/core';
import { startLocalEndpoint } from '../src/server.js';

const token = 'synthetic-local-token-0123456789';

function fixture(options: { events?: (request: CompletionRequest) => CompletionEvent[]; state?: ConnectionState; listFails?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  let aborted = false;
  const provider: SubscriptionProvider = {
    id: 'codex', displayName: 'Test',
    async getConnectionState() { return options.state ?? { status: 'connected', accountLabel: 'synthetic' }; },
    async connect() {}, async disconnect() {}, async dispose() {},
    async listModels() {
      if (options.listFails) throw Object.assign(new Error('ChatGPT authentication expired.'), { redacted: true, event: { code: 'invalid_grant', retryable: false } });
      return [{ providerId: 'codex', modelId: 'test-model', name: 'Test', contextWindow: 1000, maxOutputTokens: 100,
        capabilities: { tools: true, images: true, reasoningEfforts: [] } }];
    },
    async *complete(request) {
      requests.push(request);
      const list = options.events?.(request) ?? [{ type: 'text-delta', text: 'PROBE_OK' }, { type: 'finish', reason: 'stop' }];
      for (const event of list) {
        if (event.type === 'text-delta' && event.text === '<hang>') {
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
          return;
        }
        yield event;
      }
    },
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  const logs: string[] = [];
  return { registry, requests, logs, get aborted() { return aborted; }, logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } };
}

/** Test-only loose JSON accessor for response bodies. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();
const json = body;

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

test('binds loopback only, requires the bearer token, and serves the model list', async () => {
  const f = fixture();
  const endpoint = await startLocalEndpoint({ registry: f.registry, providerId: 'codex', token, logger: f.logger });
  try {
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const unauthorized = await fetch(`${endpoint.url}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(unauthorized.status, 401);
    const missing = await fetch(`${endpoint.url}/v1/models`);
    assert.equal(missing.status, 401);
    const ok = await fetch(`${endpoint.url}/v1/models`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { object: 'list', data: [{ id: 'test-model', object: 'model', created: 0, owned_by: 'unify-provider' }] });
    const bare = await fetch(`${endpoint.url}/models`, { headers: auth });
    assert.equal(bare.status, 200);
    const unknown = await fetch(`${endpoint.url}/v1/embeddings`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(unknown.status, 404);
    assert.ok(!f.logs.join('\n').includes(token), 'token must never be logged');
  } finally { await endpoint.close(); }
});

test('streams Chat Completions SSE with tool calls and [DONE]; rejects unknown models and bad JSON', async () => {
  const f = fixture({ events: () => [
    { type: 'text-delta', text: 'Reading.' },
    { type: 'tool-call-start', callId: 'call_1', name: 'Read' },
    { type: 'tool-arguments-delta', callId: 'call_1', delta: '{"file_path":"a.ts"}' },
    { type: 'tool-call-end', callId: 'call_1' },
    { type: 'usage', inputTokens: 3, outputTokens: 2 },
    { type: 'finish', reason: 'tool-calls' },
  ] });
  const endpoint = await startLocalEndpoint({ registry: f.registry, providerId: 'codex', token, logger: f.logger });
  try {
    const res = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({
      model: 'test-model', stream: true, max_tokens: 16000,
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }],
    }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const text = await res.text();
    const frames = text.split('\n\n').filter(Boolean).map(frame => frame.replace(/^data: /, ''));
    assert.equal(frames.at(-1), '[DONE]');
    const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame));
    assert.equal(chunks[0].object, 'chat.completion.chunk');
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.deepEqual(chunks[1].choices[0].delta, { content: 'Reading.' });
    assert.equal(chunks[2].choices[0].delta.tool_calls[0].function.name, 'Read');
    assert.equal(chunks[3].choices[0].delta.tool_calls[0].function.arguments, '{"file_path":"a.ts"}');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.equal(chunks.at(-1).usage.total_tokens, 5);
    assert.equal(f.requests[0]?.tools[0]?.name, 'Read');
    assert.equal(f.requests[0]?.messages[0]?.role, 'system');

    const unknown = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(unknown.status, 404);
    assert.equal((await body(unknown)).error.code, 'model_not_found');
    const bad = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await body(bad)).error.code, 'invalid_json');
    const required = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', tool_choice: 'required', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(required.status, 400);
    assert.equal((await body(required)).error.code, 'unsupported_parameter');
  } finally { await endpoint.close(); }
});

test('non-streaming requests assemble a chat.completion object', async () => {
  const f = fixture();
  const endpoint = await startLocalEndpoint({ registry: f.registry, providerId: 'codex', token, logger: f.logger });
  try {
    const res = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.object, 'chat.completion');
    assert.deepEqual(body.choices[0].message, { role: 'assistant', content: 'PROBE_OK' });
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally { await endpoint.close(); }
});

test('provider failures map to HTTP statuses: usage limit 429 before streaming, in-stream error frame after', async () => {
  const limited = fixture({ events: () => [{ type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'limit reached', retryable: false }] });
  const endpoint = await startLocalEndpoint({ registry: limited.registry, providerId: 'codex', token, logger: limited.logger });
  try {
    const res = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 429);
    assert.equal((await body(res)).error.code, 'subscription_sharing_usage_limit_exceeded');
  } finally { await endpoint.close(); }

  const midStream = fixture({ events: () => [{ type: 'text-delta', text: 'part' }, { type: 'error', code: 'network_error', message: 'net', retryable: true }] });
  const streaming = await startLocalEndpoint({ registry: midStream.registry, providerId: 'codex', token, logger: midStream.logger });
  try {
    const res = await fetch(`${streaming.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('[DONE]'));
    assert.match(text, /"error":\{"message":"net","type":"server_error","code":"network_error"/);
  } finally { await streaming.close(); }
});

test('disconnected or expired providers return actionable errors without fabricating models', async () => {
  const disconnected = fixture({ state: { status: 'disconnected' } });
  const a = await startLocalEndpoint({ registry: disconnected.registry, providerId: 'codex', token, logger: disconnected.logger });
  try {
    const res = await fetch(`${a.url}/v1/models`, { headers: auth });
    assert.equal(res.status, 503);
    assert.equal((await body(res)).error.code, 'not_connected');
  } finally { await a.close(); }
  const expired = fixture({ listFails: true });
  const b = await startLocalEndpoint({ registry: expired.registry, providerId: 'codex', token, logger: expired.logger });
  try {
    const res = await fetch(`${b.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(res.status, 401);
    assert.equal((await body(res)).error.code, 'invalid_grant');
  } finally { await b.close(); }
});

test('client disconnect aborts the upstream completion', async () => {
  const f = fixture({ events: () => [{ type: 'text-delta', text: 'start' }, { type: 'text-delta', text: '<hang>' }] });
  const endpoint = await startLocalEndpoint({ registry: f.registry, providerId: 'codex', token, logger: f.logger });
  try {
    const controller = new AbortController();
    const pending = fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, signal: controller.signal,
      body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const res = await pending;
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    for (let i = 0; i < 50 && !f.aborted; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.aborted, true);
  } finally { await endpoint.close(); }
});

test('oversized bodies are rejected with 413', async () => {
  const f = fixture();
  const endpoint = await startLocalEndpoint({ registry: f.registry, providerId: 'codex', token, logger: f.logger, maxBodyBytes: 64 });
  try {
    const res = await fetch(`${endpoint.url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(200) }] }) });
    assert.equal(res.status, 413);
  } finally { await endpoint.close(); }
});
