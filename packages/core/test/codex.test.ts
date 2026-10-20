import assert from 'node:assert/strict';
import { generateKeyPair, sign } from 'node:crypto';
import { promisify } from 'node:util';
import test from 'node:test';
import type { AuthHost, CompletionEvent, CompletionRequest } from '../src/core/provider.js';
import { createCodexProvider } from '../src/index.js';
import { issuer, keys, resource, scope, tokenURL, verifyIDToken } from '../src/providers/codex/auth.js';
import { errorEvent } from '../src/providers/codex/errors.js';
import type { CodexErrorEvent } from '../src/providers/codex/errors.js';
import { conservativeModelLimits, modelLimits, resolveFamilyModelLimits, resolveMaxOutputTokens } from '../src/providers/codex/model-limits.js';
import { fromResponsesStream, toResponsesRequest } from '../src/providers/codex/protocol.js';

const now = 1_800_000_000_000;
const clientId = 'oaiapp_synthetic_test';
const { privateKey, publicKey } = await promisify(generateKeyPair)('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
function jwt(nonce: string, changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...headerChanges })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: clientId, sub: 'synthetic-subject',
    email: 'synthetic@example.invalid', nonce, exp: now / 1000 + 3600, ...changes })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokenBody = (idToken?: string) => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
  token_type: 'Bearer', expires_in: 3600, scope, ...(idToken ? { id_token: idToken } : {}) });

function request(signal = new AbortController().signal): CompletionRequest {
  return { model: { providerId: 'codex', modelId: 'synthetic-model' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], tools: [], signal };
}
async function collect(stream: AsyncIterable<CompletionEvent>): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function stream(events: unknown[], chunkSize = 19): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const completed = { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } } } };

function untypedBody(text: string, chunkSize = 1, contentType?: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: contentType ? { 'Content-Type': contentType } : {} });
}

function fixture(options: {
  saved?: boolean; expired?: boolean; callback?: (url: URL) => void; token?: (nonce: string) => Record<string, unknown>;
  api?: (url: string, init: RequestInit) => Promise<Response> | Response;
  now?: () => number;
} = {}) {
  const storage = new Map<string, string>();
  if (options.saved) {
    storage.set(keys.clientId, clientId);
    storage.set(keys.hostId, 'urn:uuid:00000000-0000-4000-8000-000000000001');
    storage.set(keys.registration, JSON.stringify({ clientId, subject: 'synthetic-subject', accountLabel: 'synthetic@example.invalid' }));
    storage.set(keys.tokens, JSON.stringify({ accessToken: 'synthetic-old-access', refreshToken: 'synthetic-old-refresh',
      idToken: jwt('previous-nonce'), expiresAt: now + (options.expired ? 59_000 : 3600_000), scopes: scope.split(' ') }));
  }
  let authorize: URL | undefined;
  let callbackResponse: Promise<Response> | undefined;
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const host: AuthHost = {
    secrets: { async get(key) { return storage.get(key); }, async store(key, value) { storage.set(key, value); }, async delete(key) { storage.delete(key); } },
    async openExternal(url) {
      authorize = url;
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')!, client_id: clientId }).toString();
      options.callback?.(callback);
      callbackResponse = globalThis.fetch(callback);
      void callbackResponse.catch(() => {});
    },
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${issuer}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (url === tokenURL) {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('resource'), resource);
      assert.equal(form.get('client_id'), clientId);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('redirect_uri'), authorize?.searchParams.get('redirect_uri'));
        assert.equal(form.get('code'), 'synthetic-code');
        assert.ok(form.get('code_verifier'));
        const nonce = authorize!.searchParams.get('nonce')!;
        return json(options.token?.(nonce) ?? tokenBody(jwt(nonce)));
      }
    }
    if (options.api) return options.api(url, init);
    assert.fail(`Unexpected fixture endpoint: ${url}`);
  };
  const provider = createCodexProvider({ host, agentName: 'Unify Provider', fetch: fetcher, now: options.now ?? (() => now),
    logger: { info(msg) { logs.push(msg); }, warn(msg) { logs.push(msg); warnings.push(msg); } } });
  return { provider, host, storage, calls, logs, warnings, get authorize() { return authorize; }, get callbackResponse() { return callbackResponse; } };
}

test('first login registers with full SIWC/PKCE parameters and persists verified credentials', async () => {
  const f = fixture();
  await f.provider.connect(f.host, new AbortController().signal);
  const url = f.authorize!;
  assert.equal(url.origin + url.pathname, `${issuer}/api/accounts/authorize`);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'Unify Provider');
  assert.equal(url.searchParams.get('scope'), scope);
  assert.equal(url.searchParams.get('resource'), resource);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const name of ['state', 'nonce', 'code_challenge']) assert.ok(url.searchParams.get(name));
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/auth/callback');
  assert.ok(Number(redirect.port) > 0);
  assert.match(f.storage.get(keys.hostId)!, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(f.storage.get(keys.clientId), clientId);
  assert.equal(JSON.parse(f.storage.get(keys.registration)!).subject, 'synthetic-subject');
  assert.equal(JSON.parse(f.storage.get(keys.tokens)!).refreshToken, 'synthetic-refresh');
  assert.deepEqual(await f.provider.getConnectionState(), { status: 'connected', accountLabel: 'synthetic@example.invalid' });
  assert.equal((await f.callbackResponse!).status, 200);
  assert.ok(!f.logs.join(' ').includes('synthetic-'));
  await f.provider.dispose();
});

test('second login reuses client and stable host, omits name hint and verifies account', async () => {
  const f = fixture({ saved: true, callback(url) { url.searchParams.delete('client_id'); } });
  const oldHost = f.storage.get(keys.hostId);
  await f.provider.connect(f.host, new AbortController().signal);
  assert.equal(f.authorize!.searchParams.get('client_id'), clientId);
  assert.equal(f.authorize!.searchParams.has('agent_name_hint'), false);
  assert.equal(f.authorize!.searchParams.get('ext_agent_host_id'), oldHost);
  assert.ok(f.authorize!.searchParams.has('id_token_hint'));
  await f.callbackResponse;
  await f.provider.dispose();
});

for (const [name, options] of [
  ['mismatched state', { callback(url: URL) { url.searchParams.set('state', 'wrong'); } }],
  ['denied consent', { callback(url: URL) { url.searchParams.set('error', 'access_denied'); } }],
  ['missing issued client', { callback(url: URL) { url.searchParams.delete('client_id'); } }],
  ['missing direct scope', { token(nonce: string) { return { ...tokenBody(jwt(nonce)), scope: 'openid email' }; } }],
  ['invalid ID signature', { token(nonce: string) { return { ...tokenBody(jwt(nonce)), id_token: `${jwt(nonce).split('.').slice(0, 2).join('.')}.invalid` }; } }],
] as const) {
  test(`login rejects ${name} without usable credentials`, async () => {
    const f = fixture(options);
    await assert.rejects(f.provider.connect(f.host, new AbortController().signal));
    assert.equal(f.storage.has(keys.tokens), false);
    assert.equal((await f.provider.getConnectionState()).status, 'disconnected');
    assert.equal((await f.callbackResponse!).status, 400);
    await f.provider.dispose();
  });
}

test('returning login rejects a different issued client and preserves active account', async () => {
  const f = fixture({ saved: true, callback(url) { url.searchParams.set('client_id', 'oaiapp_different'); } });
  const prior = f.storage.get(keys.tokens);
  await assert.rejects(f.provider.connect(f.host, new AbortController().signal));
  assert.equal(f.storage.get(keys.tokens), prior);
  assert.equal(f.storage.get(keys.clientId), clientId);
  await f.callbackResponse;
  await f.provider.dispose();
});

test('returning login rejects a different verified subject without replacing tokens', async () => {
  const f = fixture({ saved: true, token(nonce) { return tokenBody(jwt(nonce, { sub: 'another-subject' })); } });
  const prior = f.storage.get(keys.tokens);
  await assert.rejects(f.provider.connect(f.host, new AbortController().signal), /different account/);
  assert.equal(f.storage.get(keys.tokens), prior);
  await f.callbackResponse;
  await f.provider.dispose();
});

for (const [name, changes, header] of [
  ['issuer', { iss: 'https://invalid.example' }, {}], ['audience', { aud: 'oaiapp_wrong' }, {}],
  ['nonce', { nonce: 'wrong' }, {}], ['expired', { exp: now / 1000 }, {}], ['subject', { sub: '' }, {}],
  ['algorithm', {}, { alg: 'HS256' }], ['kid', {}, { kid: 'wrong' }],
] as const) {
  test(`ID token validation rejects invalid ${name}`, async () => {
    await assert.rejects(verifyIDToken(jwt('expected', changes, header), clientId, 'expected',
      async () => json({ keys: [jwk] }), now, new AbortController().signal), /invalid ID token/);
  });
}

test('enforces host identity for connect and disconnect', async () => {
  const f = fixture();
  const other = { ...f.host };
  await assert.rejects(f.provider.connect(other, new AbortController().signal), /host instance/);
  await assert.rejects(f.provider.disconnect(other), /host instance/);
  assert.equal(f.authorize, undefined);
  await f.provider.dispose();
});

test('login cancellation closes loopback listener and does not save credentials', async () => {
  const f = fixture();
  const abort = new AbortController();
  let redirect: string | undefined;
  f.host.openExternal = async url => { redirect = url.searchParams.get('redirect_uri')!; abort.abort(); };
  await assert.rejects(f.provider.connect(f.host, abort.signal));
  assert.equal(f.storage.has(keys.tokens), false);
  await assert.rejects(globalThis.fetch(redirect!));
  await f.provider.dispose();
});

test('only callback path is accepted by loopback server', async () => {
  const f = fixture();
  const opener = f.host.openExternal;
  f.host.openExternal = async url => {
    const wrongPath = new URL(url.searchParams.get('redirect_uri')!);
    wrongPath.pathname = '/callback';
    assert.equal((await globalThis.fetch(wrongPath)).status, 404);
    await opener(url);
  };
  await f.provider.connect(f.host, new AbortController().signal);
  await f.callbackResponse;
  await f.provider.dispose();
});

test('cancellation also terminates a browser host that never resolves', async () => {
  const f = fixture();
  const abort = new AbortController();
  let redirect = '';
  f.host.openExternal = async url => {
    redirect = url.searchParams.get('redirect_uri')!;
    abort.abort();
    await new Promise<void>(() => {});
  };
  await assert.rejects(f.provider.connect(f.host, abort.signal));
  await assert.rejects(globalThis.fetch(redirect));
  await f.provider.dispose();
});

test('host secret storage failures cannot leak credentials through sign-in errors', async () => {
  const f = fixture();
  f.host.secrets.store = async () => { throw new Error('synthetic-secret-that-must-not-leak'); };
  await assert.rejects(f.provider.connect(f.host, new AbortController().signal), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('synthetic-secret'));
    return true;
  });
  await f.provider.dispose();
});

test('concurrent completions share one rotating refresh at expiry minus 60 seconds', async () => {
  let refreshes = 0;
  const f = fixture({ saved: true, expired: true, async api(url, init) {
    if (url === tokenURL) {
      refreshes++;
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'synthetic-old-refresh');
      assert.equal(form.has('scope'), false);
      await new Promise(resolve => setTimeout(resolve, 10));
      return json(tokenBody());
    }
    assert.equal(url, `${resource}/responses`);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-access');
    return stream([completed]);
  } });
  const results = await Promise.all([collect(f.provider.complete(request())), collect(f.provider.complete(request()))]);
  assert.equal(refreshes, 1);
  assert.ok(results.every(events => events.some(event => event.type === 'finish')));
  assert.equal(JSON.parse(f.storage.get(keys.tokens)!).refreshToken, 'synthetic-refresh');
  await f.provider.dispose();
});

for (const [name, status, body] of [
  ['401', 401, { detail: 'synthetic-old-refresh must not leak' }],
  ['invalid_grant', 400, { error: 'invalid_grant', error_description: 'synthetic-old-refresh must not leak' }],
] as const) {
  test(`refresh ${name} clears tokens and requires reauthentication`, async () => {
    const f = fixture({ saved: true, expired: true, api() { return json(body, status); } });
    const events = await collect(f.provider.complete(request()));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'error');
    assert.ok(!JSON.stringify(events).includes('synthetic-old-refresh'));
    assert.equal((await f.provider.getConnectionState()).status, 'reauthentication-required');
    assert.equal(f.storage.has(keys.tokens), false);
    assert.equal(f.storage.get(keys.clientId), clientId);
    assert.ok(f.storage.has(keys.hostId));
    await f.provider.dispose();
  });
}

test('temporary refresh failures preserve renewable credentials', async () => {
  const f = fixture({ saved: true, expired: true, api() { return json({ error: { code: 'subscription_sharing_usage_unavailable' } }, 503); } });
  const events = await collect(f.provider.complete(request()));
  assert.equal(events[0]?.type === 'error' && events[0].retryable, true);
  assert.equal((await f.provider.getConnectionState()).status, 'connected');
  assert.ok(f.storage.has(keys.tokens));
  await f.provider.dispose();
});

test('cancelling one refresh waiter does not disrupt another completion', async () => {
  const abort = new AbortController();
  let refreshes = 0;
  const f = fixture({ saved: true, expired: true, async api(url) {
    if (url === tokenURL) { refreshes++; abort.abort(); await new Promise(resolve => setTimeout(resolve, 10)); return json(tokenBody()); }
    return stream([completed]);
  } });
  const results = await Promise.allSettled([collect(f.provider.complete(request(abort.signal))), collect(f.provider.complete(request()))]);
  assert.equal(results[0]!.status, 'rejected');
  assert.equal(results[1]!.status, 'fulfilled');
  assert.equal(refreshes, 1);
  await f.provider.dispose();
});

test('model catalog filters visibility/API availability, preserves server order, maps capabilities', async () => {
  const base = { context_window: 200_000, input_modalities: ['text', 'image'], supported_in_api: true, visibility: 'list' };
  const f = fixture({ saved: true, api(url) {
    assert.equal(url, `${resource}/models`);
    return json({ models: [
      { ...base, slug: 'gpt-6.1-sol', display_name: 'Model B', supported_reasoning_levels: [{ effort: 'high' }] },
      { ...base, slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
      { ...base, slug: 'no-api', display_name: 'No API', supported_in_api: false },
      { ...base, slug: 'model-a', display_name: 'Model A', input_modalities: ['text'] },
    ] });
  } });
  const models = await f.provider.listModels(new AbortController().signal);
  assert.deepEqual(models.map(model => model.modelId), ['gpt-6.1-sol', 'model-a']);
  assert.deepEqual(models[0]!.capabilities, { tools: true, images: true, reasoningEfforts: ['high'] });
  assert.equal(models[1]!.capabilities.images, false);
  assert.equal(models[0]!.maxOutputTokens, modelLimits['gpt-6.1-sol']!.maxOutputTokens);
  assert.equal(models[0]!.contextWindow, base.context_window);
  assert.equal(models[1]!.maxOutputTokens, conservativeModelLimits.maxOutputTokens);
  await f.provider.dispose();
});

test('official model limits resolve exact slugs with verified sources', () => {
  for (const slug of ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol']) {
    assert.equal(resolveMaxOutputTokens(slug), 128_000);
    assert.equal(modelLimits[slug]!.contextWindow, 1_050_000);
    assert.equal(modelLimits[slug]!.source, `https://developers.openai.com/api/docs/models/${slug}`);
    assert.equal(modelLimits[slug]!.verifiedAt, '2026-10-20');
  }
});

test('model limits resolve date suffixes and all fast variants from their base models', () => {
  for (const [slug, limits] of Object.entries(modelLimits).filter(([slug]) => !slug.endsWith('-fast'))) {
    assert.equal(resolveMaxOutputTokens(`${slug}-2026-xx`), limits.maxOutputTokens);
    assert.equal(resolveMaxOutputTokens(`${slug}-fast`), limits.maxOutputTokens);
    assert.equal(resolveMaxOutputTokens(`${slug}-fast-2026-xx`), limits.maxOutputTokens);
    assert.deepEqual(modelLimits[`${slug}-fast`], limits);
  }
});

test('unknown slugs resolve undefined and family fallback respects generation boundaries', () => {
  for (const slug of ['unknown-model', 'gpt-6.10-sol', 'gpt-6.1-solstice', 'gpt-5.50', '__proto__', 'constructor']) {
    assert.equal(resolveMaxOutputTokens(slug), undefined);
  }
  assert.equal(resolveFamilyModelLimits('gpt-6.10-sol'), undefined);
  assert.equal(resolveFamilyModelLimits('unknown-model'), undefined);
  assert.equal(resolveFamilyModelLimits('gpt-5.6')!.maxOutputTokens, modelLimits['gpt-5.6-sol']!.maxOutputTokens);
  assert.equal(resolveFamilyModelLimits('gpt-6-unlisted-tier')!.maxOutputTokens, modelLimits['gpt-6-sol']!.maxOutputTokens);
});

test('catalog falls back to family or conservative verified limits without adding models', async () => {
  const f = fixture({ saved: true, api() { return json({ models: [
    { slug: 'gpt-5.6', display_name: 'Family', input_modalities: ['text'], supported_in_api: true, visibility: 'list' },
    { slug: 'unknown-model', display_name: 'Unknown', input_modalities: ['text'], supported_in_api: true, visibility: 'list' },
  ] }); } });
  const models = await f.provider.listModels(new AbortController().signal);
  assert.equal(models.length, 2);
  assert.equal(models[0]!.maxOutputTokens, resolveFamilyModelLimits('gpt-5.6')!.maxOutputTokens);
  assert.equal(models[0]!.contextWindow, resolveFamilyModelLimits('gpt-5.6')!.contextWindow);
  assert.equal(models[1]!.maxOutputTokens, conservativeModelLimits.maxOutputTokens);
  assert.equal(models[1]!.contextWindow, conservativeModelLimits.contextWindow);
  await f.provider.dispose();
});

test('catalog missing or small context windows leave positive VS Code input and output budgets', async () => {
  const cap = modelLimits['gpt-6.1-sol']!.maxOutputTokens;
  const windows = [undefined, null, 2, 100_000, cap, cap + 1];
  const f = fixture({ saved: true, api() { return json({ models: windows.map(context_window => ({
    slug: 'gpt-6.1-sol', display_name: 'Sol', context_window, input_modalities: ['text'], supported_in_api: true, visibility: 'list',
  })) }); } });
  const models = await f.provider.listModels(new AbortController().signal);
  for (const [index, model] of models.entries()) {
    const contextWindow = windows[index] ?? modelLimits['gpt-6.1-sol']!.contextWindow;
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.maxOutputTokens, Math.min(cap, contextWindow - 1));
    assert.ok(model.maxOutputTokens > 0);
    assert.ok(model.contextWindow - model.maxOutputTokens > 0);
  }
  await f.provider.dispose();
});

test('catalog rejects malformed context windows rather than inventing a usable window', async () => {
  for (const context_window of [0, 1, -1, 1.5, '1050000', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture({ saved: true, api() { return json({ models: [{
      slug: 'gpt-6.1-sol', display_name: 'Sol', context_window, input_modalities: ['text'], supported_in_api: true, visibility: 'list',
    }] }); } });
    await assert.rejects(f.provider.listModels(new AbortController().signal), /invalid model catalog/);
    await f.provider.dispose();
  }
});

test('multi-turn text, images, tool calls/results and opaque reasoning convert in order', () => {
  const input = request();
  input.messages = [
    { role: 'system', content: [{ type: 'text', text: 'System rules' }] },
    { role: 'developer', content: [{ type: 'text', text: 'Developer rules' }] },
    { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', mimeType: 'image/png', base64: 'c3ludGhldGlj' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'I can inspect it' }] },
    { role: 'assistant', content: [
      { type: 'provider-state', providerId: 'codex', value: { type: 'reasoning', id: 'r1', encrypted_content: 'synthetic-opaque', summary: [] } },
      { type: 'text', text: 'Checking' }, { type: 'tool-call', callId: 'call1', name: 'read_file', arguments: { path: 'example.ts' } },
      { type: 'text', text: 'Waiting for the file' },
    ] },
    { role: 'user', content: [{ type: 'tool-result', callId: 'call1', content: 'file content', isError: false }, { type: 'text', text: 'Continue' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Finished inspecting' }] },
  ];
  input.tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  input.reasoningEffort = 'high';
  input.providerOptions = { temperature: 1, max_output_tokens: 99, previous_response_id: 'bad', tools: [{ type: 'tool_search' }] };
  const body = toResponsesRequest(input);
  assert.deepEqual(body.input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'System rules' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect' }, { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'auto' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I can inspect it', annotations: [] }] },
    { type: 'reasoning', id: 'r1', encrypted_content: 'synthetic-opaque', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] },
    { type: 'function_call', call_id: 'call1', name: 'read_file', namespace: 'unify', arguments: '{"path":"example.ts"}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Waiting for the file', annotations: [] }] },
    { type: 'function_call_output', call_id: 'call1', output: 'file content' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished inspecting', annotations: [] }] },
  ]);
  for (const item of body.input as { type: string; role?: string; content?: { type: string }[] }[]) {
    if (item.type !== 'message') continue;
    assert.ok(item.content!.every(part => part.type !== 'function_call_output'));
    if (item.role === 'assistant') assert.ok(item.content!.every(part => part.type === 'output_text'));
  }
  assert.deepEqual(body.tools, [{ type: 'namespace', name: 'unify', description: 'Tools executed by the local editor.', tools: [
    { type: 'function', name: 'read_file', description: 'Read a file', parameters: input.tools[0]!.inputSchema, strict: false },
  ] }]);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  for (const field of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
    'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']) assert.equal(field in body, false);
});

test('multiple system messages retain every text part and their order as Responses developer input', () => {
  const input = request();
  input.messages = [
    { role: 'system', content: [{ type: 'text', text: 'First rule' }, { type: 'text', text: 'Second rule' }] },
    { role: 'developer', content: [{ type: 'text', text: 'Developer rule' }] },
    { role: 'system', content: [{ type: 'text', text: 'Third rule' }] },
    ...input.messages,
    { role: 'system', content: [{ type: 'text', text: 'Final rule' }] },
  ];
  assert.deepEqual(toResponsesRequest(input).input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'First rule' }, { type: 'input_text', text: 'Second rule' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer rule' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Third rule' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Final rule' }] },
  ]);
});

test('user tool outputs precede all text and images regardless of part order', () => {
  const input = request();
  input.messages = [{ role: 'user', content: [
    { type: 'text', text: 'Before' },
    { type: 'tool-result', callId: 'call1', content: 'first result', isError: false },
    { type: 'image', mimeType: 'image/png', base64: 'c3ludGhldGlj' },
    { type: 'tool-result', callId: 'call2', content: 'second result', isError: true },
    { type: 'text', text: 'After' },
  ] }];
  assert.deepEqual(toResponsesRequest(input).input, [
    { type: 'function_call_output', call_id: 'call1', output: 'first result' },
    { type: 'function_call_output', call_id: 'call2', output: 'second result' },
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'Before' },
      { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'auto' },
      { type: 'input_text', text: 'After' },
    ] },
  ]);
});

test('SSE maps text, reasoning, function argument fragments, opaque state, usage and terminal finish', async () => {
  const response = stream([
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item1', call_id: 'call1', name: 'read_file', namespace: 'unify', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item1', delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: 'item1', delta: '"example.ts"}' },
    { type: 'response.function_call_arguments.done', item_id: 'item1', arguments: '{"path":"example.ts"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item1', call_id: 'call1' } },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r1', encrypted_content: 'synthetic-opaque' } }, completed,
  ], 1);
  assert.deepEqual(await collect(fromResponsesStream(response.body!, new AbortController().signal)), [
    { type: 'text-delta', text: '你好' }, { type: 'reasoning-delta', text: 'Thinking' },
    { type: 'tool-call-start', callId: 'call1', name: 'read_file' },
    { type: 'tool-arguments-delta', callId: 'call1', delta: '{"path":' },
    { type: 'tool-arguments-delta', callId: 'call1', delta: '"example.ts"}' },
    { type: 'tool-call-end', callId: 'call1' },
    { type: 'provider-state', providerId: 'codex', value: { type: 'reasoning', id: 'r1', encrypted_content: 'synthetic-opaque' } },
    { type: 'usage', inputTokens: 12, outputTokens: 4, cachedInputTokens: 7 }, { type: 'finish', reason: 'tool-calls' },
  ]);
});

for (const code of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_user_not_eligible',
  'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user',
  'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']) {
  test(`structured ${code} is nonretryable, redacted and updates connection state`, async () => {
    const f = fixture({ saved: true, api() { return stream([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { code, message: 'synthetic-access must not leak', quota: { remaining: 0, limit: 10 } } } },
      completed,
    ]); } });
    const events = await collect(f.provider.complete(request()));
    assert.equal(events.length, 2);
    assert.equal(events[1]?.type === 'error' && events[1].code, code);
    assert.equal(events[1]?.type === 'error' && events[1].retryable, false);
    assert.ok(!JSON.stringify(events).includes('synthetic-access'));
    const state = await f.provider.getConnectionState();
    if (code === 'subscription_sharing_invalid_user') assert.equal(state.status, 'reauthentication-required');
    else {
      assert.equal(state.status === 'connected' && state.error?.code, code);
      if (code === 'subscription_sharing_usage_limit_exceeded') assert.deepEqual(state.status === 'connected' && state.quota, { remaining: 0, limit: 10, unit: 'unknown' });
    }
    await f.provider.dispose();
  });
}

test('pre-stream detail failures never leak diagnostics and HTTP errors are structured', async () => {
  const f = fixture({ saved: true, api() { return json({ detail: 'synthetic-old-access must not leak' }, 403); } });
  const events = await collect(f.provider.complete(request()));
  assert.deepEqual(events, [{ type: 'error', code: 'http_403', message: 'The ChatGPT request failed.', retryable: false,
    redacted: true, diagnostics: { stage: 'responses', status: 403, summary: 'The ChatGPT request failed.' } }]);
  await f.provider.dispose();
});

test('wire inference body is allowlisted, streamed and not stored', async () => {
  const f = fixture({ saved: true, api(url, init) {
    assert.equal(url, `${resource}/responses`);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.previous_response_id, undefined);
    return stream([completed]);
  } });
  const input = request();
  input.providerOptions = { temperature: 1, previous_response_id: 'bad', max_output_tokens: 100 };
  assert.equal((await collect(f.provider.complete(input))).at(-1)?.type, 'finish');
  await f.provider.dispose();
});

test('SSE cancellation stops all subsequent events even when already buffered', async () => {
  const abort = new AbortController();
  const f = fixture({ saved: true, api() { return stream([{ type: 'response.output_text.delta', delta: 'first' }, completed]); } });
  const iterator = f.provider.complete(request(abort.signal))[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: 'text-delta', text: 'first' });
  abort.abort(new Error('synthetic cancellation'));
  await assert.rejects(iterator.next(), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { diagnostics: { stage: string } }).diagnostics.stage, 'stream');
    assert.ok(!error.message.includes('synthetic cancellation'));
    return true;
  });
  await f.provider.dispose();
});

test('already cancelled completion does not call any endpoint', async () => {
  const f = fixture({ saved: true });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(collect(f.provider.complete(request(abort.signal))));
  assert.equal(f.calls.length, 0);
  await f.provider.dispose();
});

test('cancellation unblocks a pending SSE read and cancels the body reader', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const iterator = fromResponsesStream(response.body!, abort.signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  abort.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
});

test('interrupted and incomplete responses never produce a successful finish', async () => {
  for (const events of [[{ type: 'response.output_text.delta', delta: 'partial' }], [{ type: 'response.incomplete', response: {} }]]) {
    const parsed = await collect(fromResponsesStream(stream(events).body!, new AbortController().signal));
    assert.equal(parsed.at(-1)?.type, 'error');
    assert.equal(parsed.some(event => event.type === 'finish'), false);
  }
});

test('SSE handles comments and multiline data fields', async () => {
  const body = new Response(': keepalive\n\ndata: {"type":"response.output_text.delta",\ndata: "delta":"text"}\n\ndata: {"type":"response.completed","response":{}}\n\n').body!;
  assert.deepEqual(await collect(fromResponsesStream(body, new AbortController().signal)), [
    { type: 'text-delta', text: 'text' }, { type: 'finish', reason: 'stop' },
  ]);
});

test('unsupported opaque states and non-user image content are rejected', () => {
  const input = request();
  input.messages = [{ role: 'assistant', content: [{ type: 'provider-state', providerId: 'codex', value: { type: 'tool_search' } }] }];
  assert.throws(() => toResponsesRequest(input), /provider state/);
  input.messages = [{ role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', base64: '' }] }];
  assert.throws(() => toResponsesRequest(input), error => {
    const failure = error as Error & { diagnostics: { stage: string } };
    assert.match(failure.message, /Assistant history does not support image/);
    assert.equal(failure.diagnostics.stage, 'convert');
    return true;
  });
});

test('unknown upstream error codes cannot inject secrets into events', () => {
  const event = errorEvent({ error: { code: 'synthetic-secret-value', message: 'synthetic-secret-value' } }, 500);
  assert.equal(event.code, 'http_500');
  assert.equal(event.retryable, true);
  assert.ok(!JSON.stringify(event).includes('synthetic-secret-value'));
});

test('disconnect discovers revocation endpoint, revokes and retains registration/host', async () => {
  const f = fixture({ saved: true, api(url, init) {
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ revocation_endpoint: `${issuer}/synthetic-revoke` });
    assert.equal(url, `${issuer}/synthetic-revoke`);
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('token'), 'synthetic-old-refresh');
    assert.equal(form.get('token_type_hint'), 'refresh_token');
    assert.equal(form.get('client_id'), clientId);
    return new Response(null, { status: 200 });
  } });
  await f.provider.disconnect(f.host);
  assert.deepEqual(await f.provider.getConnectionState(), { status: 'disconnected' });
  assert.equal(f.storage.has(keys.tokens), false);
  for (const key of [keys.clientId, keys.registration, keys.hostId]) assert.ok(f.storage.has(key));
  await f.provider.dispose();
});

test('unconfirmed revocation still clears local tokens and gives a safe actionable failure', async () => {
  const f = fixture({ saved: true, api() { throw new Error('synthetic-old-refresh must not leak'); } });
  await assert.rejects(f.provider.disconnect(f.host), /remote revocation was not confirmed/);
  assert.equal(f.storage.has(keys.tokens), false);
  assert.deepEqual(await f.provider.getConnectionState(), { status: 'disconnected' });
  assert.ok(!f.logs.join(' ').includes('synthetic-old-refresh'));
  await f.provider.dispose();
});

for (const transport of ['http', 'sse-error', 'sse-failed'] as const) {
  test(`${transport} preserves unsupported parameter diagnostics without logging credentials or user content`, async () => {
    const upstream = { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'temperature',
      message: 'Bearer synthetic-old-access token echoed-user-content', body: 'synthetic-old-refresh' };
    const f = fixture({ saved: true, api() {
      return transport === 'http' ? json({ error: upstream }, 400)
        : stream([transport === 'sse-error' ? { type: 'error', error: upstream }
          : { type: 'response.failed', response: { error: upstream } }]);
    } });
    const events = await collect(f.provider.complete(request()));
    assert.equal(events.length, 1);
    const event = events[0] as Extract<CompletionEvent, { type: 'error' }> & {
      redacted: boolean; diagnostics: { stage: string; status: number; code: string; type: string; param: string; summary: string };
    };
    assert.equal(event.type, 'error');
    assert.equal(event.code, 'unsupported_parameter');
    assert.equal(event.redacted, true);
    assert.deepEqual(event.diagnostics, { stage: transport === 'http' ? 'responses' : 'stream',
      status: transport === 'http' ? 400 : 200, code: 'unsupported_parameter', type: 'invalid_request_error',
      param: 'temperature', summary: 'The ChatGPT request failed.' });
    assert.ok(f.warnings.some(log => log.includes(`"stage":"${event.diagnostics.stage}"`) && log.includes(`"status":${event.diagnostics.status}`)));
    const diagnostics = JSON.stringify(events) + f.logs.join('\n');
    for (const forbidden of ['Bearer', 'token', 'synthetic-old-access', 'synthetic-old-refresh', 'echoed-user-content', 'Hello']) {
      assert.ok(!diagnostics.includes(forbidden), `Leaked ${forbidden}`);
    }
    if (transport !== 'http') assert.ok(f.logs.some(log => log.includes('SSE ended') && log.includes('"events":1') && log.includes('"finishReason":"error"')));
    await f.provider.dispose();
  });
}

test('malformed SSE JSON produces a redacted stream failure and end statistics', async () => {
  const f = fixture({ saved: true, api() { return new Response('data: {"echoed-user-secret"\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); } });
  const events = await collect(f.provider.complete(request()));
  assert.equal(events.at(-1)?.type, 'error');
  assert.ok(f.warnings.some(log => log.includes('"stage":"stream"') && log.includes('"status":200')));
  assert.ok(f.logs.some(log => log.includes('SSE ended')));
  assert.ok(!JSON.stringify(events).includes('echoed-user-secret'));
  assert.ok(!f.logs.join(' ').includes('echoed-user-secret'));
  await f.provider.dispose();
});

test('completion logs request metadata, response timing and SSE usage, never body', async () => {
  const f = fixture({ saved: true, api() { return stream([completed]); } });
  await collect(f.provider.complete(request()));
  const logs = f.logs.join('\n');
  assert.match(logs, /model=synthetic-model input=1 tools=0 image=false/);
  assert.match(logs, /method=POST path=\/v1\/responses/);
  assert.match(logs, /status=200 elapsedMs=\d+/);
  assert.match(logs, /"events":1,"finishReason":"stop"/);
  assert.match(logs, /"inputTokens":12,"outputTokens":4,"cachedInputTokens":7/);
  for (const secret of ['Hello', 'Bearer', 'synthetic-old-access', 'synthetic-old-refresh']) assert.ok(!logs.includes(secret));
  await f.provider.dispose();
});

test('models HTTP errors preserve structured fields and trusted redaction marker', async () => {
  const f = fixture({ saved: true, api() { return json({ error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'temperature', message: 'Bearer credential' } }, 400); } });
  await assert.rejects(f.provider.listModels(new AbortController().signal), error => {
    const value = error as Error & { redacted: boolean; diagnostics: Record<string, unknown> };
    assert.equal(value.redacted, true);
    assert.equal(value.diagnostics.stage, 'models');
    assert.equal(value.diagnostics.status, 400);
    assert.equal(value.diagnostics.param, 'temperature');
    assert.ok(!value.message.includes('credential'));
    return true;
  });
  assert.ok(f.warnings.some(log => log.includes('"stage":"models"')));
  await f.provider.dispose();
});

test('refresh failure logs its lifecycle and preserves HTTP diagnostics instead of transport text', async () => {
  const f = fixture({ saved: true, expired: true, api() { return json({ error: { code: 'temporarily_unavailable', type: 'server_error', param: 'resource', message: 'Bearer synthetic-old-refresh' } }, 503); } });
  const events = await collect(f.provider.complete(request()));
  const event = events[0] as CompletionEvent & { diagnostics: Record<string, unknown> };
  assert.equal(event.diagnostics.stage, 'refresh');
  assert.equal(event.diagnostics.status, 503);
  assert.equal(event.diagnostics.type, 'server_error');
  assert.ok(f.logs.some(log => log.includes('refresh started')));
  assert.ok(f.warnings.some(log => log.includes('"stage":"refresh"') && log.includes('"status":503')));
  assert.ok(!f.logs.join(' ').includes('Bearer'));
  assert.ok(!f.logs.join(' ').includes('synthetic-old-refresh'));
  await f.provider.dispose();
});

test('conversion failures are marked convert and never emit requests or input content', async () => {
  const f = fixture({ saved: true });
  const input = request();
  input.messages = [{ role: 'assistant', content: [{ type: 'image', mimeType: 'image/png', base64: 'secret-image-content' }] }];
  const events = await collect(f.provider.complete(input));
  const event = events[0] as CompletionEvent & { diagnostics: Record<string, unknown> };
  assert.equal(event.diagnostics.stage, 'convert');
  assert.equal(f.calls.length, 0);
  assert.ok(f.warnings.some(log => log.includes('"stage":"convert"')));
  assert.ok(!f.logs.join(' ').includes('secret-image-content'));
  await f.provider.dispose();
});

test('injected transport exception messages and stacks are not retained in core errors or logs', async () => {
  const f = fixture({ saved: true, api() { throw new Error('Bearer secret-credential user-input'); } });
  const events = await collect(f.provider.complete(request()));
  assert.equal(events.at(-1)?.type, 'error');
  assert.ok(f.warnings.some(log => log.includes('"stage":"responses"') && log.includes('network_error')));
  for (const forbidden of ['Bearer', 'secret-credential', 'user-input']) {
    assert.ok(!f.logs.join(' ').includes(forbidden));
    assert.ok(!JSON.stringify(events).includes(forbidden));
  }
  await f.provider.dispose();
});

test('diagnostic fields reject free-form text and inherited message properties', () => {
  const event = errorEvent({ error: { code: 'Bearer secret', type: 'invalid_request_error\nsecret', param: 'temperature=secret', message: 'echoed-input' } }, 400);
  assert.equal(event.code, 'http_400');
  assert.equal(event.diagnostics.code, undefined);
  assert.equal(event.diagnostics.type, undefined);
  assert.equal(event.diagnostics.param, undefined);
  assert.ok(!JSON.stringify(event).includes('secret'));
  assert.equal(errorEvent({ error: { code: 'constructor' } }).message, 'The ChatGPT request failed.');
});

test('consumer cancellation logs stream failure and cancelled end statistics even on iterator return', async () => {
  const abort = new AbortController();
  const f = fixture({ saved: true, api() { return stream([{ type: 'response.output_text.delta', delta: 'private-output' }, completed]); } });
  const iterator = f.provider.complete(request(abort.signal))[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'text-delta');
  abort.abort(new Error('private-cancellation-reason'));
  await iterator.return?.();
  assert.ok(f.warnings.some(log => log.includes('"stage":"stream"') && log.includes('operation_cancelled')));
  assert.ok(f.logs.some(log => log.includes('"finishReason":"cancelled"')));
  assert.ok(!f.logs.join(' ').includes('private-output'));
  assert.ok(!f.logs.join(' ').includes('private-cancellation-reason'));
  await f.provider.dispose();
});

test('200 completed JSON Response converts text, tools, reasoning, usage and finish without an error', async () => {
  const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'private-reasoning', summary: [] };
  const f = fixture({ saved: true, api() { return json({ object: 'response', status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'private-output' }, { type: 'output_text', text: 'more' }] },
    { type: 'function_call', call_id: 'call1', name: 'unify.read', namespace: 'unify', arguments: '{"path":"private-path"}' },
    reasoning,
  ], usage: completed.response.usage }); } });
  assert.deepEqual(await collect(f.provider.complete(request())), [
    { type: 'text-delta', text: 'private-output' }, { type: 'text-delta', text: 'more' },
    { type: 'tool-call-start', callId: 'call1', name: 'read' },
    { type: 'tool-arguments-delta', callId: 'call1', delta: '{"path":"private-path"}' },
    { type: 'tool-call-end', callId: 'call1' }, { type: 'provider-state', providerId: 'codex', value: reasoning },
    { type: 'usage', inputTokens: 12, outputTokens: 4, cachedInputTokens: 7 }, { type: 'finish', reason: 'tool-calls' },
  ]);
  assert.ok(f.warnings.some(log => log.includes('"contentType":"application/json"') && log.includes('"bodyNull":false')));
  assert.ok(f.warnings.some(log => log.includes('"object":"response","status":"completed"')));
  for (const secret of ['private-output', 'private-path', 'private-reasoning', 'synthetic-old-access', 'Hello']) assert.ok(!f.logs.join('\n').includes(secret));
  await f.provider.dispose();
});

test('200 text/html reports invalid_stream with response headers and proxy/gateway hint', async () => {
  const f = fixture({ saved: true, api() { return new Response('<html>private-page</html>', { headers: {
    'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': '31', 'Transfer-Encoding': 'chunked',
  } }); } });
  const events = await collect(f.provider.complete(request()));
  const event = events[0] as CodexErrorEvent;
  assert.equal(events.length, 1);
  assert.equal(event.code, 'invalid_stream');
  assert.equal(event.diagnostics.contentType, 'text/html');
  assert.match(event.diagnostics.summary, /proxy or gateway/);
  assert.ok(f.warnings.some(log => log.includes('"contentEncoding":"gzip"') && log.includes('"contentLength":"31"') && log.includes('"transferEncoding":"chunked"')));
  assert.ok(!f.logs.join('\n').includes('private-page'));
  await f.provider.dispose();
});

for (const variant of ['failed', 'incomplete', 'error-envelope'] as const) {
  test(`200 JSON ${variant} preserves structured error identifiers without output`, async () => {
    const f = fixture({ saved: true, api() { return json({
      ...(variant === 'error-envelope' ? {} : { object: 'response', status: variant }),
      error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'temperature', message: 'private-message' },
      incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'private-output' }] }],
    }); } });
    const events = await collect(f.provider.complete(request()));
    const event = events[0] as CodexErrorEvent;
    assert.equal(events.length, 1);
    assert.equal(event.type, 'error');
    assert.equal(event.code, 'unsupported_parameter');
    assert.equal(event.diagnostics.type, 'invalid_request_error');
    assert.equal(event.diagnostics.param, 'temperature');
    assert.equal(event.diagnostics.contentType, 'application/json');
    assert.equal(event.diagnostics.incompleteReason, 'max_output_tokens');
    assert.ok(!f.logs.join('\n').includes('private-'));
    assert.ok(!JSON.stringify(events).includes('private-'));
    await f.provider.dispose();
  });
}

test('200 incomplete JSON without an error code reports response_incomplete and reason', async () => {
  const f = fixture({ saved: true, api() { return json({ object: 'response', status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } }); } });
  const event = (await collect(f.provider.complete(request())))[0] as CodexErrorEvent;
  assert.equal(event.code, 'response_incomplete');
  assert.equal(event.diagnostics.incompleteReason, 'max_output_tokens');
  await f.provider.dispose();
});

test('200 malformed completed JSON never yields a fake successful finish', async () => {
  const f = fixture({ saved: true, api() { return json({ object: 'response', status: 'completed' }); } });
  const events = await collect(f.provider.complete(request()));
  assert.equal(events.length, 1);
  assert.equal((events[0] as CodexErrorEvent).code, 'invalid_response');
  await f.provider.dispose();
});

for (const [name, preamble, chunkSize, contentType] of [
  ['missing header, split prefix', '', 1, undefined],
  ['missing header, complete first chunk', '', 4096, undefined],
  ['whitespace and split BOM', ' \r\n\uFEFF \t', 1, undefined],
  ['other content type', '', 19, 'application/octet-stream'],
] as const) {
  test(`body sniff preserves SSE text: ${name}`, async () => {
    const text = `${preamble}data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '完整首块你好' })}\n\ndata: ${JSON.stringify(completed)}\n\n`;
    const f = fixture({ saved: true, api() { return untypedBody(text, chunkSize, contentType); } });
    const events = await collect(f.provider.complete(request()));
    assert.deepEqual(events[0], { type: 'text-delta', text: '完整首块你好' });
    assert.equal(events.at(-1)?.type, 'finish');
    assert.ok(f.logs.some(log => log.includes('"sniff":"sse"') && log.includes(`"contentTypeMissing":${!contentType}`)));
    assert.ok(!f.logs.join('\n').includes('完整首块你好'));
    await f.provider.dispose();
  });
}

for (const prefix of ['event: response.output_text.delta\n', ': keepalive\n\n', 'id: synthetic\n', 'retry: 1000\n']) {
  test(`body sniff recognizes SSE ${prefix.split(':')[0]} prefix`, async () => {
    const f = fixture({ saved: true, api() { return untypedBody(`${prefix}data: ${JSON.stringify(completed)}\n\n`); } });
    assert.equal((await collect(f.provider.complete(request()))).at(-1)?.type, 'finish');
    assert.ok(f.logs.some(log => log.includes('"sniff":"sse"')));
    await f.provider.dispose();
  });
}

test('200 missing content-type JSON Response converts to events after sniff', async () => {
  const f = fixture({ saved: true, api() { return untypedBody(` \uFEFF ${JSON.stringify({ object: 'response', status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'private-json-text' }] },
  ] })}`); } });
  assert.deepEqual(await collect(f.provider.complete(request())), [{ type: 'text-delta', text: 'private-json-text' }, { type: 'finish', reason: 'stop' }]);
  assert.ok(f.logs.some(log => log.includes('"sniff":"json"')));
  assert.ok(!f.logs.join('\n').includes('private-json-text'));
  await f.provider.dispose();
});

for (const variant of ['failed', 'incomplete', 'error-envelope'] as const) {
  test(`sniffed JSON ${variant} remains a structured failure`, async () => {
    const f = fixture({ saved: true, api() { return untypedBody(JSON.stringify({
      ...(variant === 'error-envelope' ? {} : { object: 'response', status: variant }),
      error: { code: 'unsupported_parameter', param: 'temperature', message: 'private-error' },
    })); } });
    const events = await collect(f.provider.complete(request()));
    assert.equal(events.length, 1);
    const event = events[0] as CodexErrorEvent;
    assert.equal(event.code, 'unsupported_parameter');
    assert.equal(event.diagnostics.sniff, 'json');
    assert.equal(event.diagnostics.contentTypeMissing, true);
    assert.ok(!f.logs.join('\n').includes('private-error'));
    await f.provider.dispose();
  });
}

for (const [kind, text] of [['html', '<html>private-page</html>'], ['unknown', 'private-unexpected-body'], ['unknown', ' '.repeat(5000)]] as const) {
  test(`200 missing content-type ${kind} body reports sniff diagnostics`, async () => {
    let cancelled = false;
    const f = fixture({ saved: true, api() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
        cancel() { cancelled = true; },
      }));
    } });
    const event = (await collect(f.provider.complete(request())))[0] as CodexErrorEvent;
    assert.equal(event.code, 'invalid_stream');
    assert.equal(event.diagnostics.sniff, kind);
    assert.equal(event.diagnostics.bodyKind, kind);
    assert.equal(event.diagnostics.contentTypeMissing, true);
    assert.match(event.diagnostics.summary, /proxy or gateway/);
    assert.equal(cancelled, true);
    assert.ok(!f.logs.join('\n').includes('private-'));
    await f.provider.dispose();
  });
}

for (const initial of ['', 'da', 'data: {"type":"response.output_text.delta","delta":"first"}\n\n']) {
  test(`sniff path abort cancels pending read (${initial ? initial === 'da' ? 'partial prefix' : 'replayed SSE' : 'empty prefix'})`, async () => {
    const abort = new AbortController();
    let cancelled = false;
    let ready!: () => void;
    const reading = new Promise<void>(resolve => { ready = resolve; });
    const f = fixture({ saved: true, api() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { if (initial) controller.enqueue(new TextEncoder().encode(initial)); },
        pull() { ready(); }, cancel() { cancelled = true; },
      }));
    } });
    const iterator = f.provider.complete(request(abort.signal))[Symbol.asyncIterator]();
    const first = iterator.next();
    await reading;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (initial.startsWith('data:')) assert.deepEqual((await first).value, { type: 'text-delta', text: 'first' });
    const pending = initial.startsWith('data:') ? iterator.next() : first;
    abort.abort();
    await assert.rejects(pending);
    assert.equal(cancelled, true);
    await f.provider.dispose();
  });
}

for (const route of ['responses', 'models', 'refresh'] as const) {
  for (const recover of [true, false]) {
    test(`${route} fetch network errors retry twice (${recover ? 'recovers on third attempt' : 'exhausted'})`, async () => {
      let attempts = 0;
      const f = fixture({ saved: true, expired: route === 'refresh', api(url) {
        const target = route === 'refresh' ? tokenURL : `${resource}/${route}`;
        if (url === target && (++attempts <= 2 || !recover)) throw new Error('private-transport-error');
        return url === tokenURL ? json(tokenBody()) : route === 'models' ? json({ models: [] }) : stream([completed]);
      } });
      if (route === 'models') {
        const result = f.provider.listModels(new AbortController().signal);
        if (recover) assert.deepEqual(await result, []);
        else await assert.rejects(result, error => {
          const failure = error as { event: CodexErrorEvent };
          assert.equal(failure.event.code, 'network_error');
          assert.equal(failure.event.retryable, true);
          return true;
        });
      } else {
        const events = await collect(f.provider.complete(request()));
        if (recover) assert.equal(events.at(-1)?.type, 'finish');
        else {
          const event = events[0] as CodexErrorEvent;
          assert.equal(event.code, 'network_error');
          assert.equal(event.retryable, true);
        }
      }
      assert.equal(attempts, 3);
      assert.equal(f.logs.filter(log => log.includes('retrying after network error attempt=2')).length, 1);
      assert.equal(f.logs.filter(log => log.includes('retrying after network error attempt=3')).length, 1);
      assert.equal(f.logs.filter(log => log.includes('retrying after network error')).length, 2);
      assert.ok(!f.logs.join('\n').includes('private-transport-error'));
      await f.provider.dispose();
    });
  }
}

test('abort during network retry delay prevents a second fetch', async () => {
  const abort = new AbortController();
  let attempts = 0;
  const f = fixture({ saved: true, api() { attempts++; setTimeout(() => abort.abort(), 10); throw new Error('private-error'); } });
  await assert.rejects(collect(f.provider.complete(request(abort.signal))));
  assert.equal(attempts, 1);
  await f.provider.dispose();
});

for (const contentType of [undefined, 'text/event-stream', 'application/json']) {
  test(`response body failure never retries fetch (${contentType ?? 'sniff'})`, async () => {
    let attempts = 0;
    const f = fixture({ saved: true, api() {
      attempts++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(contentType === 'application/json' ? '{' : 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n')); },
        pull(controller) { controller.error(new Error('private-stream-error')); },
      }), { headers: contentType ? { 'Content-Type': contentType } : {} });
    } });
    const events = await collect(f.provider.complete(request()));
    assert.equal(events.at(-1)?.type, 'error');
    assert.equal(events.some(event => event.type === 'finish'), false);
    assert.equal(attempts, 1);
    assert.ok(!f.logs.some(log => log.includes('retrying')));
    await f.provider.dispose();
  });
}

test('HTTP errors never trigger automatic network retries', async () => {
  const f = fixture({ saved: true, api() { return json({ error: { code: 'temporarily_unavailable' } }, 503); } });
  await collect(f.provider.complete(request()));
  assert.equal(f.calls.length, 1);
  assert.ok(!f.logs.some(log => log.includes('retrying')));
  await f.provider.dispose();
});

test('model catalogs cache for ten minutes, force bypasses, and caller mutations cannot corrupt cache', async () => {
  let clock = now;
  const f = fixture({ saved: true, now: () => clock, api() { return json({ models: [{
    slug: 'gpt-6.1-sol', display_name: 'Sol', input_modalities: ['text'], supported_in_api: true, visibility: 'list',
  }] }); } });
  const signal = new AbortController().signal;
  const first = await f.provider.listModels(signal);
  first[0]!.name = 'mutated';
  assert.equal((await f.provider.listModels(signal))[0]!.name, 'Sol');
  assert.equal(f.calls.length, 1);
  await f.provider.listModels(signal, { force: true });
  assert.equal(f.calls.length, 2);
  clock += 10 * 60_000;
  await f.provider.listModels(signal);
  assert.equal(f.calls.length, 3);
  await f.provider.dispose();
});

test('concurrent model discovery shares a request and cancelling one waiter does not cancel it', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ saved: true, async api() { await gate; return json({ models: [] }); } });
  const abort = new AbortController();
  const cancelled = f.provider.listModels(abort.signal);
  const active = f.provider.listModels(new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort();
  await assert.rejects(cancelled);
  release();
  assert.deepEqual(await active, []);
  assert.equal(f.calls.length, 1);
  await f.provider.dispose();
});

test('failed force refresh clears model cache so the next discovery hits the network', async () => {
  let count = 0;
  const f = fixture({ saved: true, api() { return ++count === 2 ? json({ error: { code: 'temporarily_unavailable' } }, 503) : json({ models: [] }); } });
  const signal = new AbortController().signal;
  await f.provider.listModels(signal);
  await assert.rejects(f.provider.listModels(signal, { force: true }));
  await f.provider.listModels(signal);
  assert.equal(count, 3);
  await f.provider.dispose();
});

test('connect and disconnect invalidate the authenticated model catalog', async () => {
  let catalogs = 0;
  const f = fixture({ saved: true, api(url) {
    if (url === `${resource}/models`) { catalogs++; return json({ models: [] }); }
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ revocation_endpoint: `${issuer}/synthetic-revoke` });
    assert.equal(url, `${issuer}/synthetic-revoke`);
    return new Response(null, { status: 200 });
  } });
  const signal = new AbortController().signal;
  await f.provider.listModels(signal);
  await f.provider.connect(f.host, signal);
  await f.callbackResponse;
  await f.provider.listModels(signal);
  assert.equal(catalogs, 2);
  await f.provider.disconnect(f.host);
  await assert.rejects(f.provider.listModels(signal));
  assert.equal(catalogs, 2);
  await f.provider.connect(f.host, signal);
  await f.callbackResponse;
  await f.provider.listModels(signal);
  assert.equal(catalogs, 3);
  await f.provider.dispose();
});

test('token refresh failure clears a still-fresh catalog and recovered discovery reloads it', async () => {
  let clock = now;
  let catalogs = 0;
  let refreshes = 0;
  const f = fixture({ saved: true, now: () => clock, api(url) {
    if (url === tokenURL) return ++refreshes === 1 ? json({ error: { code: 'temporarily_unavailable' } }, 503) : json(tokenBody());
    assert.equal(url, `${resource}/models`);
    catalogs++;
    return json({ models: [] });
  } });
  const tokens = JSON.parse(f.storage.get(keys.tokens)!);
  tokens.expiresAt = now + 120_000;
  f.storage.set(keys.tokens, JSON.stringify(tokens));
  const signal = new AbortController().signal;
  await f.provider.listModels(signal);
  clock += 60_001;
  await assert.rejects(f.provider.listModels(signal));
  assert.equal((await f.provider.getConnectionState()).status, 'connected');
  await f.provider.listModels(signal);
  assert.equal(catalogs, 2);
  assert.equal(refreshes, 2);
  await f.provider.dispose();
});

test('200 non-SSE null body reports bodyNull and content type without reading content', async () => {
  const f = fixture({ saved: true, api() { return new Response(null, { headers: { 'Content-Type': 'application/json' } }); } });
  const event = (await collect(f.provider.complete(request())))[0] as CodexErrorEvent;
  assert.equal(event.code, 'invalid_stream');
  assert.equal(event.diagnostics.contentType, 'application/json');
  assert.ok(f.warnings.some(log => log.includes('"bodyNull":true')));
  await f.provider.dispose();
});
