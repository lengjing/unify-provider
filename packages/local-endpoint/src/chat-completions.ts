import type { ChatMessage, CompletionEvent, ContentPart, JsonValue, ModelDescriptor, ToolDefinition } from '@unify-provider/core';

/**
 * OpenAI Chat Completions <-> core contract conversion.
 *
 * Scope is the request shape observed from Trae (docs/compatibility.md, Trae section h):
 * `model`, `stream`, `max_tokens`, `messages` (system string, user text/image_url parts,
 * assistant text + tool_calls, tool results) and `tools` as function tools.
 * Unsupported features fail explicitly instead of being silently dropped or faked.
 */

/** Locally authored, content-free diagnostics; safe to return to the calling editor. */
export class ChatCompletionsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ChatCompletionsError';
  }
}

const invalid = (message: string, code = 'invalid_request_error') => new ChatCompletionsError(400, code, message);

export interface ChatCompletionsRequest {
  modelId: string;
  stream: boolean;
  includeUsage: boolean;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  reasoningEffort?: string;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${what} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function json(value: unknown, what: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, what));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, json(child, what)]));
  }
  throw invalid(`${what} must be JSON.`);
}

/** Only data URLs are accepted: the endpoint never fetches remote images on the editor's behalf. */
function imagePart(url: unknown): ContentPart {
  if (typeof url !== 'string') throw invalid('image_url.url must be a string.');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (!match) throw invalid('Only data:image/{png,jpeg,webp,gif};base64 image URLs are supported.', 'unsupported_image_url');
  return { type: 'image', mimeType: match[1]!, base64: match[2]!.replace(/\s+/g, '') };
}

function contentParts(content: unknown, role: ChatMessage['role'], allowImages: boolean): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw invalid(`${role} message content must be a string or an array of parts.`);
  return content.map(raw => {
    const part = record(raw, 'Message content part');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid('text part requires a string text field.');
      return { type: 'text', text: part.text } as const;
    }
    if (part.type === 'image_url') {
      if (!allowImages) throw invalid(`${role} messages cannot contain image_url parts.`);
      return imagePart(record(part.image_url, 'image_url').url);
    }
    throw invalid(`Unsupported ${role} content part type.`, 'unsupported_content_part');
  });
}

function toolResultText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('tool message content must be a string or an array of text parts.');
  return content.map(raw => {
    const part = record(raw, 'Tool content part');
    if (part.type !== 'text' || typeof part.text !== 'string') throw invalid('tool message content parts must be text.', 'unsupported_content_part');
    return part.text;
  }).join('\n');
}

function toolCallPart(raw: unknown): ContentPart {
  const call = record(raw, 'tool_calls item');
  if (call.type !== undefined && call.type !== 'function') throw invalid('Only function tool calls are supported.', 'unsupported_tool_call');
  const fn = record(call.function, 'tool_calls[].function');
  if (typeof call.id !== 'string' || !call.id) throw invalid('tool_calls[].id must be a non-empty string.');
  if (typeof fn.name !== 'string' || !fn.name) throw invalid('tool_calls[].function.name must be a non-empty string.');
  let args: unknown = {};
  if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
    try { args = JSON.parse(fn.arguments); } catch { throw invalid('tool_calls[].function.arguments must be a JSON string.'); }
  } else if (fn.arguments !== undefined && fn.arguments !== null && typeof fn.arguments !== 'string') {
    args = fn.arguments;
  }
  return { type: 'tool-call', callId: call.id, name: fn.name, arguments: json(args, 'Tool call arguments') };
}

export function convertMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('messages must be a non-empty array.');
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    const message = record(item, 'messages item');
    switch (message.role) {
      case 'system':
      case 'developer':
        messages.push({ role: message.role, content: contentParts(message.content, message.role, false) });
        break;
      case 'user':
        messages.push({ role: 'user', content: contentParts(message.content, 'user', true) });
        break;
      case 'assistant': {
        const content = contentParts(message.content, 'assistant', false);
        if (message.tool_calls !== undefined && message.tool_calls !== null) {
          if (!Array.isArray(message.tool_calls)) throw invalid('assistant tool_calls must be an array.');
          content.push(...message.tool_calls.map(toolCallPart));
        }
        messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw invalid('tool messages require tool_call_id.');
        const result: ContentPart = { type: 'tool-result', callId: message.tool_call_id, content: toolResultText(message.content), isError: false };
        // Core carries tool results inside a user turn; consecutive tool messages share one turn.
        const previous = messages.at(-1);
        if (previous?.role === 'user' && previous.content.every(part => part.type === 'tool-result')) {
          messages[messages.length - 1] = { role: 'user', content: [...previous.content, result] };
        } else {
          messages.push({ role: 'user', content: [result] });
        }
        break;
      }
      case 'function':
        throw invalid('Legacy function messages are not supported; use tool messages.', 'unsupported_role');
      default:
        throw invalid('Unsupported message role.', 'unsupported_role');
    }
  }
  return messages;
}

export function convertTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('tools must be an array.');
  const names = new Set<string>();
  return raw.map(item => {
    const tool = record(item, 'tools item');
    if (tool.type !== 'function') throw invalid('Only function tools are supported.', 'unsupported_tool_type');
    const fn = record(tool.function, 'tools[].function');
    if (typeof fn.name !== 'string' || !fn.name) throw invalid('tools[].function.name must be a non-empty string.');
    if (names.has(fn.name)) throw invalid('Duplicate tool name.');
    names.add(fn.name);
    const parameters = fn.parameters === undefined || fn.parameters === null
      ? { type: 'object', properties: {} }
      : json(record(fn.parameters, 'tools[].function.parameters'), 'Tool parameters');
    return {
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      inputSchema: parameters as { [key: string]: JsonValue },
    };
  });
}

/** Validate and convert a Chat Completions body. Sampling fields are ignored: SIWC preview rejects them upstream. */
export function convertRequest(body: unknown, model: ModelDescriptor): ChatCompletionsRequest {
  const request = record(body, 'Request body');
  if (typeof request.model !== 'string' || !request.model) throw invalid('model must be a non-empty string.');
  if (request.n !== undefined && request.n !== null && request.n !== 1) throw invalid('n must be 1.', 'unsupported_parameter');
  if (request.response_format !== undefined && request.response_format !== null) {
    const format = record(request.response_format, 'response_format');
    if (format.type !== 'text') throw invalid('response_format other than text is not supported.', 'unsupported_parameter');
  }
  let tools = convertTools(request.tools);
  if (request.functions !== undefined && request.functions !== null) throw invalid('Legacy functions are not supported; use tools.', 'unsupported_parameter');
  const choice = request.tool_choice;
  if (choice === 'none') tools = [];
  else if (choice !== undefined && choice !== null && choice !== 'auto') {
    // The core contract has no tool-choice field; required/forced calls cannot be honored.
    throw invalid('tool_choice must be "auto" or "none".', 'unsupported_parameter');
  }
  if (tools.length && !model.capabilities.tools) throw invalid('This model does not support tool calling.', 'unsupported_parameter');
  const messages = convertMessages(request.messages);
  if (!model.capabilities.images && messages.some(m => m.content.some(p => p.type === 'image'))) {
    throw invalid('This model does not support image input.', 'unsupported_parameter');
  }
  let reasoningEffort: string | undefined;
  if (request.reasoning_effort !== undefined && request.reasoning_effort !== null) {
    if (typeof request.reasoning_effort !== 'string' || !model.capabilities.reasoningEfforts.includes(request.reasoning_effort)) {
      throw invalid('reasoning_effort is not supported by this model.', 'unsupported_parameter');
    }
    reasoningEffort = request.reasoning_effort;
  }
  const options = request.stream_options === undefined || request.stream_options === null ? {} : record(request.stream_options, 'stream_options');
  return {
    modelId: request.model, stream: request.stream === true, includeUsage: options.include_usage === true,
    messages, tools, ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{ index: 0; delta: Record<string, unknown>; finish_reason: 'stop' | 'tool_calls' | 'length' | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export type StreamOutcome =
  | { kind: 'finished' }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

type Usage = NonNullable<ChatCompletionChunk['usage']>;

/**
 * Translate core events to Chat Completions stream chunks. Provider state is dropped: the
 * calling editor has no field to replay opaque reasoning items. Reasoning summaries are
 * emitted as `reasoning_content`, never as assistant text.
 */
export async function* toChunks(events: AsyncIterable<CompletionEvent>, id: string, model: string, created: number):
  AsyncGenerator<ChatCompletionChunk, StreamOutcome> {
  const chunk = (delta: Record<string, unknown>, finish: ChatCompletionChunk['choices'][0]['finish_reason'] = null, usage?: Usage): ChatCompletionChunk => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
  });
  const calls = new Map<string, number>();
  let usage: Usage | undefined;
  let finished = false;
  let hasTools = false;
  yield chunk({ role: 'assistant', content: '' });
  for await (const event of events) {
    switch (event.type) {
      case 'text-delta': if (event.text) yield chunk({ content: event.text }); break;
      case 'reasoning-delta': if (event.text) yield chunk({ reasoning_content: event.text }); break;
      case 'tool-call-start': {
        if (calls.has(event.callId)) return { kind: 'error', code: 'invalid_response', message: 'Duplicate tool call ID in model output.', retryable: false };
        const index = calls.size;
        calls.set(event.callId, index);
        hasTools = true;
        yield chunk({ tool_calls: [{ index, id: event.callId, type: 'function', function: { name: event.name, arguments: '' } }] });
        break;
      }
      case 'tool-arguments-delta': {
        const index = calls.get(event.callId);
        if (index === undefined) return { kind: 'error', code: 'invalid_response', message: 'Tool arguments arrived before the tool call.', retryable: false };
        if (event.delta) yield chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] });
        break;
      }
      case 'tool-call-end':
        if (!calls.has(event.callId)) return { kind: 'error', code: 'invalid_response', message: 'Tool call ended before it started.', retryable: false };
        break;
      case 'usage':
        usage = { prompt_tokens: event.inputTokens, completion_tokens: event.outputTokens, total_tokens: event.inputTokens + event.outputTokens };
        break;
      case 'error':
        return { kind: 'error', code: event.code, message: event.message, retryable: event.retryable };
      case 'finish':
        finished = true;
        yield chunk({}, event.reason === 'tool-calls' || hasTools ? 'tool_calls' : event.reason === 'length' ? 'length' : 'stop', usage);
        break;
      case 'provider-state': break;
    }
  }
  if (!finished) {
    // An upstream stream that ends without finish is incomplete; do not present it as a complete answer.
    return { kind: 'error', code: 'incomplete_response', message: 'The model response ended before completion.', retryable: true };
  }
  return { kind: 'finished' };
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: 0; message: Record<string, unknown>; finish_reason: 'stop' | 'tool_calls' | 'length' }>;
  usage?: Usage;
}

/** Collect chunks into a single non-streaming completion object. */
export function assemble(chunks: readonly ChatCompletionChunk[], id: string, model: string, created: number): ChatCompletion {
  let content = '';
  let reasoning = '';
  const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  let finish: ChatCompletion['choices'][0]['finish_reason'] = 'stop';
  let usage: Usage | undefined;
  for (const chunk of chunks) {
    const choice = chunk.choices[0]!;
    if (typeof choice.delta.content === 'string') content += choice.delta.content;
    if (typeof choice.delta.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const call of choice.delta.tool_calls as Array<{ index: number; id?: string; function: { name?: string; arguments: string } }>) {
        const existing = calls[call.index];
        if (existing) existing.function.arguments += call.function.arguments;
        else calls[call.index] = { id: call.id ?? '', type: 'function', function: { name: call.function.name ?? '', arguments: call.function.arguments } };
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const message: Record<string, unknown> = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}
