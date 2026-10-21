import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { before, test } from 'node:test';
import type * as vscode from 'vscode';
import type { ConnectionState, SubscriptionProvider } from '@unify-provider/core';
import { ProviderRegistry } from '@unify-provider/core';

// A narrow host API stub, not evidence of real VS Code compatibility.
const stubURL = pathToFileURL(`${__dirname}/vscode-stub.cjs`).href;
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'vscode' ? { url: stubURL, format: 'commonjs', shortCircuit: true } : next(specifier, context);
} });
let ChatModelProvider: typeof import('../src/provider.js').ChatModelProvider;
before(async () => {
  ({ ChatModelProvider } = await import('../src/provider.js'));
  hooks.deregister();
});

function fixture() {
  let state: ConnectionState = { status: 'connected', accountLabel: 'synthetic-account' };
  let calls = 0;
  let load = async () => [{ providerId: 'codex', modelId: 'test-model', name: 'Test', contextWindow: 200, maxOutputTokens: 50,
    capabilities: { tools: true, images: false, reasoningEfforts: [] } }];
  const provider: SubscriptionProvider = {
    id: 'codex', displayName: 'Test', async getConnectionState() { return state; },
    async connect() {}, async disconnect() {}, async dispose() {}, async *complete() {},
    async listModels() { calls++; return load(); },
  };
  const chat = new ChatModelProvider(new ProviderRegistry(), provider, async () => {}, async () => {}, async () => {}, () => 'described', { info() {}, warn() {} });
  const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  return { chat, get calls() { return calls; }, setState(value: ConnectionState) { state = value; },
    setLoad(value: typeof load) { load = value; }, discover: () => chat.provideLanguageModelChatInformation({ silent: true }, token) };
}

test('repeated/concurrent model information discovery within ten seconds calls core once', async () => {
  const f = fixture();
  const results = await Promise.all([f.discover(), f.discover()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await f.discover())[0]?.maxInputTokens, 150);
  assert.equal(f.calls, 1);
  f.chat.dispose();
});

test('extension model information cache expires at ten seconds', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture();
  await f.discover();
  context.mock.timers.tick(9999);
  await f.discover();
  assert.equal(f.calls, 1);
  context.mock.timers.tick(1);
  await f.discover();
  assert.equal(f.calls, 2);
  f.chat.dispose();
});

test('connection/account changes and notifications invalidate extension catalog', async () => {
  const f = fixture();
  await f.discover();
  f.setState({ status: 'disconnected' });
  assert.deepEqual(await f.discover(), []);
  f.setState({ status: 'connected', accountLabel: 'another-account' });
  await f.discover();
  assert.equal(f.calls, 2);
  f.chat.notifyChanged();
  await f.discover();
  assert.equal(f.calls, 3);
  f.chat.dispose();
});

test('failed discovery is not cached', async () => {
  const f = fixture();
  f.setLoad(async () => { throw new Error('synthetic failure'); });
  assert.deepEqual(await f.discover(), []);
  await f.discover();
  assert.equal(f.calls, 2);
  f.chat.dispose();
});

test('notification during pending discovery prevents returning stale models', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setLoad(async () => { await gate; return []; });
  const pending = f.discover();
  await new Promise(resolve => setTimeout(resolve, 5));
  f.chat.notifyChanged();
  release();
  assert.deepEqual(await pending, []);
  await f.discover();
  assert.equal(f.calls, 2);
  f.chat.dispose();
});
