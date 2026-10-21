import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompletionEvent } from '@unify-provider/core';
import { CompletionStreamError, ConversionError, convertEvents, convertMessages, convertTools } from '../src/convert.js';

async function* events(...values: CompletionEvent[]): AsyncIterable<CompletionEvent> { yield* values; }
async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const part of source) result.push(part);
  return result;
}

test('multi-turn instructions, user, assistant tool call and user tool result retain roles and IDs', () => {
  const result = convertMessages([
    { role: 'system', name: undefined, content: [{ value: 'Follow instructions' }] },
    { role: 1, name: undefined, content: [{ value: 'Read a file' }] },
    { role: 2, name: undefined, content: [{ callId: 'call-1', name: 'read', input: { path: 'a.ts' } }] },
    { role: 1, name: undefined, content: [{ callId: 'call-1', content: [{ value: 'const a = 1;' }] }, { value: 'Now explain' }] },
  ]);
  assert.deepEqual(result, [
    { role: 'system', content: [{ type: 'text', text: 'Follow instructions' }] },
    { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
    { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-1', name: 'read', arguments: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool-result', callId: 'call-1', content: 'const a = 1;', isError: false }, { type: 'text', text: 'Now explain' }] },
  ]);
});

test('numeric System role retains all text parts and ignores the optional message name', () => {
  assert.deepEqual(convertMessages([{ role: 3, name: 'host', content: [{ value: 'First rule' }, { value: 'Second rule' }] }]), [
    { role: 'system', content: [{ type: 'text', text: 'First rule' }, { type: 'text', text: 'Second rule' }] },
  ]);
});

test('System messages reject tool-result parts explicitly', () => {
  for (const role of [3, 'system'] as const) {
    assert.throws(() => convertMessages([{ role, name: undefined, content: [{ callId: 'a', content: [{ value: 'result' }] }] }]), {
      constructor: ConversionError, message: 'Tool-result parts are not allowed in System messages.',
    });
  }
});

test('System messages reject tool-call parts explicitly', () => {
  assert.throws(() => convertMessages([{ role: 3, name: undefined, content: [{ callId: 'a', name: 'read', input: {} }] }]), {
    constructor: ConversionError, message: 'Tool-call parts are not allowed in System messages.',
  });
});

test('System messages reject image parts explicitly', () => {
  assert.throws(() => convertMessages([{ role: 3, name: undefined, content: [{ mimeType: 'image/png', data: new Uint8Array([1]) }] }]), {
    constructor: ConversionError, message: 'Image/data parts are not allowed in System messages; only text is supported.',
  });
});

test('unknown numeric roles include the role value in the conversion error', () => {
  assert.throws(() => convertMessages([{ role: 7, name: undefined, content: [{ value: 'Not included in diagnostics' }] }]), {
    constructor: ConversionError, message: 'Unsupported VS Code message role: 7.',
  });
});

test('named developer messages preserve their role', () => {
  assert.deepEqual(convertMessages([{ role: 'developer', name: undefined, content: [{ value: 'Developer rule' }] }]), [
    { role: 'developer', content: [{ type: 'text', text: 'Developer rule' }] },
  ]);
});

test('tools retain names, descriptions and JSON schemas', () => {
  const tool = { name: 'read', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
  assert.deepEqual(convertTools([tool]), [tool]);
  assert.deepEqual(convertTools(), []);
});

test('stream text and interleaved fragmented tool arguments become complete output parts', async () => {
  assert.deepEqual(await collect(convertEvents(events(
    { type: 'text-delta', text: 'Reading' },
    { type: 'reasoning-delta', text: 'private' },
    { type: 'tool-call-start', callId: 'a', name: 'read' },
    { type: 'tool-call-start', callId: 'b', name: 'list' },
    { type: 'tool-arguments-delta', callId: 'a', delta: '{"pa' },
    { type: 'tool-arguments-delta', callId: 'b', delta: '{}' },
    { type: 'tool-call-end', callId: 'b' },
    { type: 'tool-arguments-delta', callId: 'a', delta: 'th":"a.ts"}' },
    { type: 'tool-call-end', callId: 'a' },
    { type: 'usage', inputTokens: 10, outputTokens: 4 },
    { type: 'finish', reason: 'tool-calls' },
  ))), [
    { type: 'text', value: 'Reading' },
    { type: 'tool-call', callId: 'b', name: 'list', input: {} },
    { type: 'tool-call', callId: 'a', name: 'read', input: { path: 'a.ts' } },
  ]);
});

test('invalid JSON arguments fail without reflecting argument content', async () => {
  await assert.rejects(collect(convertEvents(events(
    { type: 'tool-call-start', callId: 'a', name: 'read' },
    { type: 'tool-arguments-delta', callId: 'a', delta: '{bad synthetic secret' },
    { type: 'tool-call-end', callId: 'a' },
  ))), /not valid JSON/);
});

test('error events preserve code, message and retryable', async () => {
  await assert.rejects(collect(convertEvents(events({ type: 'error', code: 'quota_exhausted', message: 'Synthetic limit', retryable: false }))), error => {
    assert.ok(error instanceof CompletionStreamError);
    assert.equal(error.code, 'quota_exhausted');
    assert.equal(error.retryable, false);
    assert.match(error.message, /quota_exhausted.*Synthetic limit.*retryable=false/);
    return true;
  });
});

test('image data converts to core base64, non-image data fails explicitly', () => {
  assert.deepEqual(convertMessages([{ role: 1, name: undefined, content: [{ mimeType: 'image/png', data: new Uint8Array([1, 2]) }] }]), [
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64: 'AQI=' }] },
  ]);
  assert.throws(() => convertMessages([{ role: 1, name: undefined, content: [{ mimeType: 'audio/wav', data: new Uint8Array() }] }]), /image/);
});

test('unknown parts and tool results outside User are rejected rather than losing context', () => {
  assert.throws(() => convertMessages([{ role: 2, name: undefined, content: [{ callId: 'a', content: [{ value: 'result' }] }] }]), /User/);
  assert.throws(() => convertMessages([{ role: 1, name: undefined, content: [{ callId: 'a', content: [{ value: { promptTsx: true } }] }] }]), /non-text/);
  assert.throws(() => convertMessages([{ role: 1, name: undefined, content: [{}] }]), /context was not discarded/);
});

test('incomplete and unstarted tool streams fail', async () => {
  await assert.rejects(collect(convertEvents(events({ type: 'tool-call-start', callId: 'a', name: 'read' }))), /ended early/);
  await assert.rejects(collect(convertEvents(events({ type: 'tool-arguments-delta', callId: 'a', delta: '{}' }))), /missing/);
});

test('tool arguments must be JSON objects, not arrays or null', async () => {
  for (const delta of ['[]', 'null']) {
    await assert.rejects(collect(convertEvents(events(
      { type: 'tool-call-start', callId: 'a', name: 'read' },
      { type: 'tool-arguments-delta', callId: 'a', delta },
      { type: 'tool-call-end', callId: 'a' },
    ))), /JSON object/);
  }
});
