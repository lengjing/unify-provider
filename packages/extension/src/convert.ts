import type { LanguageModelChatRequestMessage, LanguageModelChatTool } from 'vscode';
import type { ChatMessage, CompletionEvent, ContentPart, JsonValue, ToolDefinition } from '@unify-provider/core';

// Stable VS Code exposes only User=1/Assistant=2, but Copilot Chat can send System=3:
// https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.languageModelSystem.d.ts
// Recognize the numeric role without enabling languageModelSystem in enabledApiProposals;
// enabling the proposal would require users to run VS Code with special flags.
// Also accept named system/developer roles; never reinterpret user text as instructions.
export type InputMessage = Omit<LanguageModelChatRequestMessage, 'role'> & {
  role: number | 'system' | 'developer';
};
export type OutputPart = { type: 'text'; value: string }
  | { type: 'tool-call'; callId: string; name: string; input: object };

/** Locally authored messages and numeric role metadata; safe for UI, never includes user content. */
export class ConversionError extends Error {
  readonly code = 'conversion_failed';
  constructor(message: string) { super(message); this.name = 'ConversionError'; }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ConversionError('Unsupported VS Code message part.');
  return value as Record<string, unknown>;
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child)]));
  }
  throw new ConversionError('Tool arguments or schemas must be JSON.');
}

function resultText(value: unknown): string {
  const part = record(value);
  if (typeof part.value === 'string') return part.value;
  // PromptTsxPart is not plain text: fail explicitly rather than silently dropping tool output.
  throw new ConversionError('Tool results contain unsupported non-text parts (such as PromptTsx or images).');
}

function convertPart(value: unknown, role: ChatMessage['role']): ContentPart {
  const part = record(value);
  if (typeof part.callId === 'string' && Array.isArray(part.content)) {
    if (role === 'system') throw new ConversionError('Tool-result parts are not allowed in System messages.');
    if (role !== 'user') throw new ConversionError('Tool results must be in User messages.');
    return { type: 'tool-result', callId: part.callId,
      content: part.content.map(resultText).join('\n'), isError: part.isError === true };
  }
  if (typeof part.callId === 'string' && typeof part.name === 'string' && 'input' in part) {
    if (role === 'system') throw new ConversionError('Tool-call parts are not allowed in System messages.');
    if (role !== 'assistant') throw new ConversionError('Tool calls must be in Assistant messages.');
    return { type: 'tool-call', callId: part.callId, name: part.name, arguments: json(part.input) };
  }
  // LanguageModelDataPart is not in the 1.104 typings. Its documented structural
  // shape lets newer hosts provide images without a runtime vscode dependency here.
  if (typeof part.mimeType === 'string' && part.data instanceof Uint8Array) {
    if (role === 'system') throw new ConversionError('Image/data parts are not allowed in System messages; only text is supported.');
    if (!part.mimeType.startsWith('image/')) throw new ConversionError('Only image/* data input is supported.');
    return { type: 'image', mimeType: part.mimeType, base64: Buffer.from(part.data).toString('base64') };
  }
  if (typeof part.value === 'string') return { type: 'text', text: part.value };
  throw new ConversionError('Unsupported VS Code message part; context was not discarded.');
}

export function convertMessages(messages: readonly InputMessage[]): ChatMessage[] {
  return messages.map(message => {
    let role: ChatMessage['role'];
    switch (message.role) {
      case 1: role = 'user'; break;
      case 2: role = 'assistant'; break;
      case 3: role = 'system'; break;
      case 'system': case 'developer': role = message.role; break;
      default: throw new ConversionError(typeof message.role === 'number'
        ? `Unsupported VS Code message role: ${message.role}.`
        : 'Unsupported VS Code message role.');
    }
    // Core ChatMessage has no name field; ignore optional host message names.
    return { role, content: message.content.map(part => convertPart(part, role)) };
  });
}

export function convertTools(tools: readonly LanguageModelChatTool[] = []): ToolDefinition[] {
  return tools.map(tool => {
    const inputSchema = json(tool.inputSchema);
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new ConversionError('Tool inputSchema must be a JSON object.');
    }
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

export class CompletionStreamError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean,
    readonly event?: Extract<CompletionEvent, { type: 'error' }>) {
    super(`[${code}] ${message} (retryable=${retryable})`);
    this.name = 'CompletionStreamError';
  }
}

export async function* convertEvents(events: AsyncIterable<CompletionEvent>): AsyncIterable<OutputPart> {
  const calls = new Map<string, { name: string; arguments: string }>();
  for await (const event of events) {
    switch (event.type) {
      case 'text-delta': yield { type: 'text', value: event.text }; break;
      case 'tool-call-start':
        if (calls.has(event.callId)) throw new ConversionError('Duplicate tool call ID.');
        calls.set(event.callId, { name: event.name, arguments: '' }); break;
      case 'tool-arguments-delta': {
        const call = calls.get(event.callId);
        if (!call) throw new ConversionError('Tool argument delta is missing tool-call-start.');
        call.arguments += event.delta; break;
      }
      case 'tool-call-end': {
        const call = calls.get(event.callId);
        if (!call) throw new ConversionError('Tool call end is missing tool-call-start.');
        let input: unknown;
        try { input = JSON.parse(call.arguments); }
        catch { throw new ConversionError('Tool call arguments are not valid JSON; the tool was not executed.'); }
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ConversionError('Tool call arguments must be a JSON object; the tool was not executed.');
        }
        calls.delete(event.callId);
        yield { type: 'tool-call', callId: event.callId, name: call.name, input }; break;
      }
      case 'error': throw new CompletionStreamError(event.code, event.message, event.retryable, event);
      // Stable 1.104 has no reasoning/state response part. Never expose private
      // reasoning as assistant text, nor embed opaque provider state in user text.
      case 'reasoning-delta': case 'provider-state': case 'usage': case 'finish': break;
    }
  }
  if (calls.size) throw new ConversionError('Response ended early: tool arguments are incomplete; the tool was not executed.');
}
