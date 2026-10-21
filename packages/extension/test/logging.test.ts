import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompletionEvent } from '@unify-provider/core';
import { CompletionStreamError, ConversionError, convertEvents } from '../src/convert.js';
import { logError } from '../src/logging.js';

function logger() {
  const warnings: string[] = [];
  const debug: string[] = [];
  return { warnings, debug, warn: (message: string) => warnings.push(message), debugLog: (message: string) => debug.push(message) };
}

test('untrusted Error messages and stacks cannot leak credentials to output', () => {
  const logs = logger();
  const error = new Error('Bearer synthetic-secret token user content');
  logError({ warn: logs.warn, debug: logs.debugLog }, error);
  assert.deepEqual(JSON.parse(logs.warnings[0]!.slice('Unify Provider failure '.length)), { name: 'Error' });
  assert.ok(![...logs.warnings, ...logs.debug].join(' ').includes('synthetic-secret'));
});

test('trusted conversion errors log code, authored message and debug stack', () => {
  const logs = logger();
  const error = new ConversionError('Tool arguments or schemas must be JSON.');
  logError({ warn: logs.warn, debug: logs.debugLog }, error);
  assert.match(logs.warnings[0]!, /conversion_failed/);
  assert.match(logs.warnings[0]!, /Tool arguments or schemas must be JSON/);
  assert.equal(logs.debug[0], error.stack);
});

test('stream conversion preserves core diagnostics for the output boundary', async () => {
  const event = { type: 'error' as const, code: 'unsupported_parameter', message: 'The ChatGPT request failed.', retryable: false,
    redacted: true, diagnostics: { stage: 'responses', status: 400, code: 'unsupported_parameter', type: 'invalid_request_error', param: 'temperature', summary: 'The ChatGPT request failed.' } };
  async function* events(): AsyncIterable<CompletionEvent> { yield event; }
  const logs = logger();
  await assert.rejects(async () => { for await (const part of convertEvents(events())) void part; }, error => {
    assert.ok(error instanceof CompletionStreamError);
    assert.equal(error.event, event);
    logError({ warn: logs.warn, debug: logs.debugLog }, error);
    return true;
  });
  for (const field of ['responses', '400', 'unsupported_parameter', 'invalid_request_error', 'temperature']) assert.ok(logs.warnings[0]!.includes(field));
});
