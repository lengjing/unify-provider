/** Provider IDs remain extensible; only Codex is in the MVP scope. */
export type ProviderId = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ModelReference {
  providerId: ProviderId;
  modelId: string;
}

export interface ModelDescriptor extends ModelReference {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: {
    tools: boolean;
    images: boolean;
    reasoningEfforts: readonly string[];
  };
}

/** Subscription quota as reported by the provider; absent fields mean the provider does not expose them. */
export interface QuotaInfo {
  remaining?: number;
  limit?: number;
  /** ISO 8601 timestamp of the next reset, when known. */
  resetsAt?: string;
  unit: 'requests' | 'tokens' | 'credits' | 'unknown';
}

export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | {
      status: 'connected'; accountLabel: string; quota?: QuotaInfo;
      /** Request restriction while identity remains connected (quota, eligibility, unsupported features). */
      error?: { code: string; message: string; retryable: boolean };
    }
  | { status: 'reauthentication-required'; message: string };

/** Host implementations own browser opening and credential persistence. */
export interface AuthHost {
  openExternal(url: URL): Promise<void>;
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }
  | { type: 'tool-call'; callId: string; name: string; arguments: JsonValue }
  | { type: 'tool-result'; callId: string; content: string; isError: boolean }
  // Preserve opaque reasoning state without interpreting it as user text.
  | { type: 'provider-state'; providerId: ProviderId; value: JsonValue };

/**
 * Tool results are 'tool-result' parts inside a 'user' message, never a separate role:
 * a single representation keeps protocol conversion unambiguous and lets one user turn
 * carry several results plus follow-up text, which is how caller-executed tools behave.
 */
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: readonly ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
}

export interface CompletionRequest {
  model: ModelReference;
  messages: readonly ChatMessage[];
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
  reasoningEffort?: string;
  /** Namespaced provider features which are not covered by the common contract. */
  providerOptions?: Readonly<Record<string, JsonValue>>;
}

export type CompletionEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; callId: string; name: string }
  | { type: 'tool-arguments-delta'; callId: string; delta: string }
  | { type: 'tool-call-end'; callId: string }
  | { type: 'provider-state'; providerId: ProviderId; value: JsonValue }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  /** Provider-reported failure surfaced in-stream so hosts can show a specific state (for example quota exhausted). */
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' };

/** Providers yield model output; the editor remains responsible for executing tools. */
export interface SubscriptionProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  getConnectionState(): Promise<ConnectionState>;
  connect(host: AuthHost, signal: AbortSignal): Promise<void>;
  disconnect(host: AuthHost): Promise<void>;
  /** Providers may cache catalogs; force bypasses the cached result. */
  listModels(signal: AbortSignal, options?: { force?: boolean }): Promise<readonly ModelDescriptor[]>;
  complete(request: CompletionRequest): AsyncIterable<CompletionEvent>;
  dispose(): Promise<void>;
}
