import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompletionEvent, ModelDescriptor } from '@unify-provider/core';
import { assemble, ChatCompletionsError, convertMessages, convertRequest, convertTools, toChunks } from '../src/chat-completions.js';

const model: ModelDescriptor = {
  providerId: 'codex', modelId: 'test-model', name: 'Test', contextWindow: 1000, maxOutputTokens: 100,
  capabilities: { tools: true, images: true, reasoningEfforts: ['low', 'high'] },
};
const textOnly: ModelDescriptor = { ...model, capabilities: { tools: false, images: false, reasoningEfforts: [] } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('Trae-shaped request converts: system string, user parts with image, function tools', () => {
  const request = convertRequest({
    model: 'test-model', max_tokens: 16000, stream: true, temperature: 0.2,
    tools: [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }],
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }, { type: 'text', text: 'colour?' }] },
    ],
  }, model);
  assert.equal(request.stream, true);
  assert.deepEqual(request.messages[0], { role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] });
  assert.deepEqual(request.messages[1], { role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64: png }, { type: 'text', text: 'colour?' }] });
  assert.equal(request.tools[0]?.name, 'Read');
  assert.deepEqual(request.tools[0]?.inputSchema.required, ['file_path']);
  assert.equal(request.reasoningEffort, undefined);
});

test('assistant tool_calls and tool results round-trip into core parts; consecutive tool results share a user turn', () => {
  const messages = convertMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
      { id: 'call_2', type: 'function', function: { name: 'LS', arguments: '' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'a.ts' }, { type: 'text', text: 'b.ts' }] },
    { role: 'user', content: 'thanks' },
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[1], { role: 'assistant', content: [
    { type: 'tool-call', callId: 'call_1', name: 'Read', arguments: { file_path: 'a.ts' } },
    { type: 'tool-call', callId: 'call_2', name: 'LS', arguments: {} },
  ] });
  assert.deepEqual(messages[2], { role: 'user', content: [
    { type: 'tool-result', callId: 'call_1', content: 'file body', isError: false },
    { type: 'tool-result', callId: 'call_2', content: 'a.ts\nb.ts', isError: false },
  ] });
  assert.deepEqual(messages[3], { role: 'user', content: [{ type: 'text', text: 'thanks' }] });
});

test('unsupported features fail explicitly with 400 instead of being dropped', () => {
  const base = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
  const expect = (body: unknown, code: string, target = model) => {
    assert.throws(() => convertRequest(body, target), (error: unknown) => error instanceof ChatCompletionsError && error.status === 400 && error.code === code);
  };
  expect({ ...base, tool_choice: 'required' }, 'unsupported_parameter');
  expect({ ...base, n: 2 }, 'unsupported_parameter');
  expect({ ...base, response_format: { type: 'json_object' } }, 'unsupported_parameter');
  expect({ ...base, reasoning_effort: 'medium' }, 'unsupported_parameter');
  expect({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] }, 'unsupported_image_url');
  expect({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }] }, 'unsupported_parameter', textOnly);
  expect({ ...base, tools: [{ type: 'function', function: { name: 'x' } }] }, 'unsupported_parameter', textOnly);
  expect({ ...base, messages: [{ role: 'function', name: 'x', content: 'y' }] }, 'unsupported_role');
  assert.throws(() => convertTools([{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'a' } }]), /Duplicate tool name/);
  // tool_choice none drops tools; reasoning_effort accepted when the model supports it.
  const ok = convertRequest({ ...base, tool_choice: 'none', reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'x' } }] }, model);
  assert.equal(ok.tools.length, 0);
  assert.equal(ok.reasoningEffort, 'high');
});

async function* events(list: CompletionEvent[]): AsyncIterable<CompletionEvent> { for (const event of list) yield event; }

async function collect(list: CompletionEvent[]) {
  const stream = toChunks(events(list), 'chatcmpl-x', 'test-model', 1);
  const chunks = [];
  for (;;) { const next = await stream.next(); if (next.done) return { chunks, outcome: next.value }; chunks.push(next.value); }
}

test('core events become chat.completion.chunk deltas with indexed tool_calls and reasoning_content', async () => {
  const { chunks, outcome } = await collect([
    { type: 'reasoning-delta', text: 'thinking' },
    { type: 'text-delta', text: 'Hel' }, { type: 'text-delta', text: 'lo' },
    { type: 'tool-call-start', callId: 'call_a', name: 'Read' },
    { type: 'tool-arguments-delta', callId: 'call_a', delta: '{"file_path":' },
    { type: 'tool-arguments-delta', callId: 'call_a', delta: '"a.ts"}' },
    { type: 'tool-call-end', callId: 'call_a' },
    { type: 'provider-state', providerId: 'codex', value: { type: 'reasoning', encrypted_content: 'opaque' } },
    { type: 'usage', inputTokens: 10, outputTokens: 5 },
    { type: 'finish', reason: 'tool-calls' },
  ]);
  assert.deepEqual(outcome, { kind: 'finished' });
  assert.deepEqual(chunks[0]?.choices[0]?.delta, { role: 'assistant', content: '' });
  assert.deepEqual(chunks[1]?.choices[0]?.delta, { reasoning_content: 'thinking' });
  assert.deepEqual(chunks[3]?.choices[0]?.delta, { content: 'lo' });
  assert.deepEqual(chunks[4]?.choices[0]?.delta, { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] });
  assert.deepEqual(chunks[5]?.choices[0]?.delta, { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] });
  const last = chunks.at(-1)!;
  assert.equal(last.choices[0]?.finish_reason, 'tool_calls');
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.ok(!JSON.stringify(chunks).includes('opaque'), 'opaque provider state must never reach the editor');
  const completion = assemble(chunks, 'chatcmpl-x', 'test-model', 1);
  assert.deepEqual(completion.choices[0]?.message, { role: 'assistant', content: 'Hello', reasoning_content: 'thinking',
    tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] });
  assert.equal(completion.choices[0]?.finish_reason, 'tool_calls');
});

test('provider error events and truncated streams are reported, not presented as answers', async () => {
  const failed = await collect([{ type: 'text-delta', text: 'partial' }, { type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', retryable: false }]);
  assert.deepEqual(failed.outcome, { kind: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', retryable: false });
  const truncated = await collect([{ type: 'text-delta', text: 'partial' }]);
  assert.equal(truncated.outcome.kind, 'error');
  assert.equal(truncated.outcome.kind === 'error' && truncated.outcome.code, 'incomplete_response');
  const orphan = await collect([{ type: 'tool-arguments-delta', callId: 'nope', delta: '{' }]);
  assert.equal(orphan.outcome.kind === 'error' && orphan.outcome.code, 'invalid_response');
});
