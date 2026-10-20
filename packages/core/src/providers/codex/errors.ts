import type { CompletionEvent, QuotaInfo } from '../../core/provider.js';

export const terminalAuthCodes = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);
const messages: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: 'ChatGPT plan or app usage limit reached. Manage usage at https://chatgpt.com/settings/usage.',
  subscription_sharing_user_not_eligible: 'ChatGPT plan usage is unavailable for this account or workspace.',
  subscription_sharing_unsupported_capability: 'This request uses a capability not supported by ChatGPT plan usage.',
  subscription_sharing_route_not_supported: 'This route is not supported by ChatGPT plan usage.',
  subscription_sharing_invalid_user: 'The ChatGPT subscriber identity could not be validated.',
  chatpass_v2_scope_not_authorized: 'The ChatGPT grant does not authorize this operation.',
  chatpass_v2_invalid_authorization_context: 'The ChatGPT authorization context is invalid.',
  subscription_sharing_usage_unavailable: 'ChatGPT usage information is temporarily unavailable.',
  subscription_sharing_user_unavailable: 'ChatGPT account information is temporarily unavailable.',
};
const nonRetryable = new Set(Object.keys(messages).filter(code => !code.endsWith('_unavailable')));

export type Stage = 'sign-in' | 'refresh' | 'models' | 'responses' | 'stream' | 'convert';
export interface Diagnostics {
  stage: Stage;
  status?: number;
  code?: string;
  type?: string;
  param?: string;
  contentType?: string | null;
  contentTypeMissing?: boolean;
  sniff?: 'sse' | 'json' | 'html' | 'unknown';
  bodyKind?: 'html' | 'unknown';
  incompleteReason?: string;
  summary: string;
}
export type CodexErrorEvent = Extract<CompletionEvent, { type: 'error' }> & { redacted: true; diagnostics: Diagnostics };

/** Only bounded protocol identifiers, never free-form messages, headers or bodies. */
export function diagnosticIdentifier(value: unknown, param = false): string | undefined {
  return typeof value === 'string' && (param ? /^[a-z][a-z0-9_.\[\]-]{0,95}$/ : /^[a-z][a-z0-9_]{0,95}$/).test(value)
    ? value : undefined;
}

export function localError(stage: Stage, summary: string, code = 'codex_request_failed', status = 0): CodexError {
  return new CodexError({ type: 'error', code, message: summary, retryable: code === 'network_error',
    redacted: true, diagnostics: { stage, ...(status ? { status } : {}), code, summary } });
}

export function safeError(error: unknown, stage: Stage, cancelled = false, status = 0): CodexError {
  if (cancelled) return localError(stage, 'The ChatGPT operation was cancelled.', 'operation_cancelled', status || (error instanceof CodexError ? error.status : 0));
  if (error instanceof CodexError) return error;
  return localError(stage, `The ChatGPT ${stage} operation failed.`, 'codex_request_failed', status);
}

export function failureLog(error: CodexErrorEvent): string {
  return `ChatGPT failure ${JSON.stringify({ ...error.diagnostics, code: error.diagnostics.code ?? error.code })}`;
}

/** Never forward upstream diagnostic text: it can contain credentials or echoed inputs. */
export function errorEvent(body: unknown, status = 0, stage: Stage = 'responses'): CodexErrorEvent {
  const value = object(body);
  const error = typeof value.error === 'string' ? { code: value.error } : object(value.error ?? value);
  const raw = diagnosticIdentifier(error.code);
  const upstreamType = diagnosticIdentifier(error.type);
  const param = diagnosticIdentifier(error.param, true);
  const code = raw ?? (status ? `http_${status}` : 'responses_error');
  const summary = (Object.hasOwn(messages, code) ? messages[code] : undefined) ?? (terminalAuthCodes.has(code) || status === 401
    ? 'ChatGPT authentication expired. Sign in again.' : 'The ChatGPT request failed.');
  return {
    type: 'error', code,
    message: summary, redacted: true,
    diagnostics: { stage, ...(status ? { status } : {}), ...(raw ? { code: raw } : {}),
      ...(upstreamType ? { type: upstreamType } : {}),
      ...(param ? { param } : {}), summary },
    retryable: !nonRetryable.has(code) && !terminalAuthCodes.has(code) && (code === 'network_error' || status === 429 || status >= 500 || code.endsWith('_unavailable')),
  };
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function reportedQuota(body: unknown): QuotaInfo {
  const root = object(body);
  const source = object(object(root.error).quota ?? root.quota);
  const unit = source.unit;
  return {
    unit: unit === 'requests' || unit === 'tokens' || unit === 'credits' ? unit : 'unknown',
    ...(typeof source.remaining === 'number' && Number.isFinite(source.remaining) ? { remaining: source.remaining } : {}),
    ...(typeof source.limit === 'number' && Number.isFinite(source.limit) ? { limit: source.limit } : {}),
    ...(typeof source.resets_at === 'string' && Number.isFinite(Date.parse(source.resets_at))
      ? { resetsAt: new Date(source.resets_at).toISOString() } : {}),
  };
}

export class CodexError extends Error {
  readonly redacted = true;
  readonly diagnostics: Diagnostics;
  readonly status: number;
  readonly body: unknown;
  constructor(readonly event: CodexErrorEvent, status = 0, body: unknown = undefined) {
    super(event.message);
    this.name = 'CodexError';
    this.diagnostics = event.diagnostics;
    this.status = status || event.diagnostics.status || 0;
    // Keep only quota needed for state updates, never retain upstream text on exceptions.
    this.body = { quota: reportedQuota(body) };
  }
}
