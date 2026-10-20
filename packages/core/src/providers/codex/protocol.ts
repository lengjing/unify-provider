import type { CompletionEvent, CompletionRequest, JsonValue } from '../../core/provider.js';
import { errorEvent, localError, object, safeError } from './errors.js';
import type { CodexErrorEvent } from './errors.js';

const namespace = 'unify';
const localName = (name: string) => name.startsWith(`${namespace}.`) ? name.slice(namespace.length + 1) : name;

/** Build an allowlisted body; arbitrary providerOptions cannot bypass preview restrictions. */
export function toResponsesRequest(request: CompletionRequest): Record<string, unknown> {
  try { return convertResponsesRequest(request); }
  catch (error) { throw safeError(error, 'convert'); }
}

function convertResponsesRequest(request: CompletionRequest): Record<string, unknown> {
  if (request.model.providerId !== 'codex') throw localError('convert', 'Codex received a request for another provider');
  const input: unknown[] = [];
  for (const message of request.messages) {
    let content: unknown[] = [];
    const role = message.role === 'system' ? 'developer' : message.role;
    const flush = () => {
      if (content.length) input.push({ type: 'message', role, content });
      content = [];
    };
    // Tool outputs are independent items and precede any remaining user input.
    if (role === 'user') {
      for (const part of message.content) {
        if (part.type === 'tool-result') input.push({ type: 'function_call_output', call_id: part.callId, output: part.content });
      }
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          // input_text is only for input-side roles; assistant history uses output_text.
          content.push(role === 'assistant'
            ? { type: 'output_text', text: part.text, annotations: [] }
            : { type: 'input_text', text: part.text });
          break;
        case 'image':
          if (role === 'assistant') throw localError('convert', 'Assistant history does not support image content');
          if (role !== 'user' || !/^image\/(png|jpeg|webp|gif)$/.test(part.mimeType)) throw localError('convert', 'Unsupported image input');
          content.push({ type: 'input_image', image_url: `data:${part.mimeType};base64,${part.base64}`, detail: 'auto' });
          break;
        case 'tool-call':
          if (role !== 'assistant') throw localError('convert', 'Tool calls must be assistant content');
          flush();
          input.push({ type: 'function_call', call_id: part.callId, name: part.name, namespace, arguments: JSON.stringify(part.arguments) });
          break;
        case 'tool-result':
          if (role !== 'user') throw localError('convert', 'Tool results must be user content');
          break;
        case 'provider-state':
          flush();
          if (part.providerId === 'codex') {
            const state = object(part.value);
            // Only replay opaque reasoning items, never let provider state inject other input features.
            if (state.type !== 'reasoning') throw localError('convert', 'Unsupported Codex provider state');
            input.push(part.value);
          }
          break;
      }
    }
    flush();
  }
  return {
    model: request.model.modelId, input, store: false, stream: true,
    include: ['reasoning.encrypted_content'],
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort, summary: 'auto' } } : {}),
    ...(request.tools.length ? { tools: [{
      type: 'namespace', name: namespace, description: 'Tools executed by the local editor.',
      tools: request.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
    }] } : {}),
  };
}

/** Tolerate a server ignoring stream:true; the official streaming contract still requires SSE. */
export function* fromResponsesJSON(body: unknown): Iterable<CompletionEvent> {
  const response = object(body);
  if (response.object !== 'response' || response.status !== 'completed' || !Array.isArray(response.output)) {
    throw localError('responses', 'ChatGPT returned an invalid Response object.', 'invalid_response', 200);
  }
  // Validate before yielding: a malformed completed object must not look like a successful reply.
  for (const raw of response.output) {
    const item = object(raw);
    if (item.type === 'message') {
      if (!Array.isArray(item.content) || item.content.some(raw => {
        const part = object(raw);
        return part.type !== 'output_text' || typeof part.text !== 'string';
      })) throw localError('responses', 'ChatGPT returned unsupported message content.', 'invalid_response', 200);
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
        || typeof item.arguments !== 'string' || (item.namespace !== undefined && item.namespace !== namespace)) {
        throw localError('responses', 'ChatGPT returned an invalid tool call.', 'invalid_response', 200);
      }
    } else if (item.type !== 'reasoning') {
      throw localError('responses', 'ChatGPT returned an unsupported output item.', 'invalid_response', 200);
    }
  }
  let hasTools = false;
  for (const raw of response.output) {
    const item = object(raw);
    if (item.type === 'message') {
      for (const part of (item.content as unknown[]).map(object)) yield { type: 'text-delta', text: part.text as string };
    } else if (item.type === 'function_call') {
      hasTools = true;
      const callId = item.call_id as string;
      yield { type: 'tool-call-start', callId, name: localName(item.name as string) };
      yield { type: 'tool-arguments-delta', callId, delta: item.arguments as string };
      yield { type: 'tool-call-end', callId };
    } else if (item.type === 'reasoning') {
      yield { type: 'provider-state', providerId: 'codex', value: item as JsonValue };
    }
  }
  const usage = object(response.usage);
  if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
    const cached = object(usage.input_tokens_details).cached_tokens;
    yield { type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}) };
  }
  yield { type: 'finish', reason: hasTools ? 'tool-calls' : 'stop' };
}

/** Inspect at most 4 KiB, retaining every read byte for the eventual consumer. */
export async function sniffResponsesBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{
  kind: 'sse' | 'json' | 'html' | 'unknown'; body: ReadableStream<Uint8Array>;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const prefixes = ['event:', 'data:', ':', 'id:', 'retry:'];
  let prefix = '';
  let inspected = 0;
  let done = false;
  let kind: 'sse' | 'json' | 'html' | 'unknown' = 'unknown';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  };
  const cancel = async () => { await reader.cancel().catch(() => {}); release(); };
  const abort = () => { void cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (inspected < 4096) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      done = chunk.done;
      if (chunk.done) prefix += decoder.decode();
      else {
        chunks.push(chunk.value);
        const sample = chunk.value.subarray(0, 4096 - inspected);
        inspected += sample.length;
        prefix += decoder.decode(sample, { stream: true });
      }
      const text = prefix.trimStart();
      if (prefixes.some(value => text.startsWith(value))) { kind = 'sse'; break; }
      if (text.startsWith('{')) { kind = 'json'; break; }
      if (text.startsWith('<')) { kind = 'html'; break; }
      if (done || (text && !prefixes.some(value => value.startsWith(text)))) break;
    }
    signal.throwIfAborted();
    // Pull-based replay preserves backpressure and propagates consumer cancellation.
    let index = 0;
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
          if (done) { controller.close(); release(); return; }
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) { controller.close(); release(); }
          else controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); await cancel(); }
      },
      cancel,
    });
    return { kind, body: replay };
  } catch (error) { await cancel(); throw error; }
}

/** Parse SSE across arbitrary UTF-8/network boundaries, including CRLF and multiline data. */
async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal, skipPreamble: boolean): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataLength = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw localError('stream', 'Responses stream frame too large', 'stream_frame_too_large');
      if (skipPreamble) {
        buffer = buffer.trimStart();
        if (buffer) skipPreamble = false;
      }
      if (chunk.done && buffer) buffer += '\n';
      let position: number;
      while ((position = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, position).replace(/\r$/, '');
        buffer = buffer.slice(position + 1);
        if (!line && data.length) {
          const payload = data.join('\n');
          data = [];
          dataLength = 0;
           if (payload !== '[DONE]') {
             try { yield JSON.parse(payload) as unknown; }
             catch { throw localError('stream', 'ChatGPT returned malformed SSE JSON.', 'invalid_sse_json'); }
           }
        } else if (line.startsWith('data:')) {
          dataLength += line.length;
          if (dataLength > 8 * 1024 * 1024) throw localError('stream', 'Responses stream frame too large', 'stream_frame_too_large');
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (chunk.done) {
        if (data.length && data.join('\n') !== '[DONE]') {
          try { yield JSON.parse(data.join('\n')) as unknown; }
          catch { throw localError('stream', 'ChatGPT returned malformed SSE JSON.', 'invalid_sse_json'); }
        }
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* fromResponsesStream(
  body: ReadableStream<Uint8Array>, signal: AbortSignal,
  onError: (event: CodexErrorEvent, body: unknown) => Promise<void> = async () => {},
  onEnd: (stats: { events: number; finishReason: string; usage?: Extract<CompletionEvent, { type: 'usage' }> }) => void = () => {},
  skipPreamble = false,
): AsyncIterable<CompletionEvent> {
  const calls = new Map<string, { callId: string; name: string; ended: boolean }>();
  let hasTools = false;
  let events = 0;
  let finishReason = 'interrupted';
  let reportedUsage: Extract<CompletionEvent, { type: 'usage' }> | undefined;
  try {
  for await (const raw of sse(body, signal, skipPreamble)) {
    events++;
    signal.throwIfAborted();
    const event = object(raw);
    const item = object(event.item);
    const response = object(event.response);
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') yield { type: 'text-delta', text: event.delta };
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof event.delta === 'string') yield { type: 'reasoning-delta', text: event.delta };
        break;
      case 'response.output_item.added':
        if (item.type === 'function_call' && typeof item.id === 'string' && typeof item.call_id === 'string' && typeof item.name === 'string') {
          if (item.namespace !== undefined && item.namespace !== namespace) throw localError('stream', 'Unexpected tool namespace');
          hasTools = true;
          const call = { callId: item.call_id, name: localName(item.name), ended: false };
          calls.set(item.id, call);
          yield { type: 'tool-call-start', callId: call.callId, name: call.name };
          if (typeof item.arguments === 'string' && item.arguments) yield { type: 'tool-arguments-delta', callId: call.callId, delta: item.arguments };
        }
        break;
      case 'response.function_call_arguments.delta': {
        const call = calls.get(String(event.item_id));
        if (!call || typeof event.delta !== 'string') throw localError('stream', 'Invalid tool argument stream');
        yield { type: 'tool-arguments-delta', callId: call.callId, delta: event.delta };
        break;
      }
      case 'response.output_item.done': {
        const call = calls.get(String(item.id));
        if (call && !call.ended) {
          call.ended = true;
          yield { type: 'tool-call-end', callId: call.callId };
        }
        if (item.type === 'reasoning') yield { type: 'provider-state', providerId: 'codex', value: item as JsonValue };
        break;
      }
      case 'error':
      case 'response.failed': {
        const failure = event.type === 'response.failed' ? response : event;
        const error = errorEvent(failure, 0, 'stream');
        finishReason = 'error';
        await onError(error, failure);
        signal.throwIfAborted();
        yield error;
        return;
      }
      case 'response.incomplete': {
        const error = localError('stream', 'ChatGPT returned an incomplete response.', 'response_incomplete').event;
        finishReason = 'incomplete';
        await onError(error, response);
        signal.throwIfAborted();
        yield error;
        return;
      }
      case 'response.completed': {
        for (const call of calls.values()) {
          if (!call.ended) throw localError('stream', 'ChatGPT completed before tool arguments ended');
        }
        const usage = object(response.usage);
        if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
          const cached = object(usage.input_tokens_details).cached_tokens;
          reportedUsage = { type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
             ...(typeof cached === 'number' ? { cachedInputTokens: cached } : {}) };
          yield reportedUsage;
        }
        signal.throwIfAborted();
        finishReason = hasTools ? 'tool-calls' : 'stop';
        yield { type: 'finish', reason: hasTools ? 'tool-calls' : 'stop' };
        return;
      }
    }
  }
  signal.throwIfAborted();
  const interrupted = localError('stream', 'ChatGPT stream ended without response.completed.', 'stream_interrupted').event;
  interrupted.retryable = true;
  await onError(interrupted, undefined);
  yield interrupted;
  } catch (error) {
    finishReason = signal.aborted ? 'cancelled' : 'error';
    const failure = safeError(error, 'stream', signal.aborted);
    await onError(failure.event, undefined);
    if (signal.aborted) throw failure;
    yield failure.event;
  } finally {
    if (signal.aborted && finishReason !== 'cancelled') {
      finishReason = 'cancelled';
      await onError(localError('stream', 'The ChatGPT operation was cancelled.', 'operation_cancelled').event, undefined);
    }
    onEnd({ events, finishReason, ...(reportedUsage ? { usage: reportedUsage } : {}) });
  }
}
