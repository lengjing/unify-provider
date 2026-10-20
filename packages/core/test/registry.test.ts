import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../src/core/registry.js';
import type { CompletionEvent, CompletionRequest, SubscriptionProvider } from '../src/core/provider.js';

function fixture(
  id: string,
  onRequest: (request: CompletionRequest) => void = () => {},
  events: readonly CompletionEvent[] = [
    { type: 'text-delta', text: id },
    { type: 'finish', reason: 'stop' },
  ],
): SubscriptionProvider {
  return {
    id,
    displayName: id,
    async getConnectionState() { return { status: 'disconnected' }; },
    async connect() {},
    async disconnect() {},
    async listModels() { return []; },
    async *complete(request) {
      onRequest(request);
      yield* events;
    },
    async dispose() {},
  };
}

function request(providerId: string, signal = new AbortController().signal): CompletionRequest {
  return {
    model: { providerId, modelId: 'test-model' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    signal,
  };
}

async function collect(stream: AsyncIterable<CompletionEvent>): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('routes to the selected provider without altering request or falling back', async () => {
  const registry = new ProviderRegistry();
  const input = request('codex');
  registry.register(fixture('other', () => assert.fail('wrong account invoked')));
  registry.register(fixture('codex', (received) => assert.equal(received, input)));
  assert.deepEqual(await collect(registry.complete(input)), [
    { type: 'text-delta', text: 'codex' },
    { type: 'finish', reason: 'stop' },
  ]);
  await assert.rejects(collect(registry.complete(request('missing'))), /Unknown provider/);
});

test('rejects duplicates without replacing the registered account', () => {
  const registry = new ProviderRegistry();
  const provider = fixture('codex');
  registry.register(provider);
  assert.throws(() => registry.register(fixture('codex')), /already registered/);
  assert.equal(registry.get('codex'), provider);
});

test('does not invoke a provider when already cancelled', async () => {
  const registry = new ProviderRegistry();
  registry.register(fixture('codex', () => assert.fail('cancelled request invoked provider')));
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(collect(registry.complete(request('codex', controller.signal))), /cancelled/);
});

test('stops forwarding output when cancellation occurs during a stream', async () => {
  const registry = new ProviderRegistry();
  const controller = new AbortController();
  registry.register(fixture('codex', () => controller.abort(new Error('cancelled mid-stream'))));
  await assert.rejects(collect(registry.complete(request('codex', controller.signal))), /cancelled mid-stream/);
});

test('forwards provider error events unchanged instead of swallowing or throwing', async () => {
  const registry = new ProviderRegistry();
  const error: CompletionEvent = {
    type: 'error',
    code: 'quota_exhausted',
    message: 'Subscription quota exhausted until 2026-11-01T00:00:00Z',
    retryable: false,
  };
  registry.register(fixture('codex', () => {}, [{ type: 'text-delta', text: 'partial' }, error]));
  assert.deepEqual(await collect(registry.complete(request('codex'))), [
    { type: 'text-delta', text: 'partial' },
    error,
  ]);
});
