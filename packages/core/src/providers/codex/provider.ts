import { setTimeout as delay } from 'node:timers/promises';
import type { AuthHost, CompletionEvent, CompletionRequest, ConnectionState, ModelDescriptor, SubscriptionProvider } from '../../core/provider.js';
import { issuer, keys, parseTokens, requestJSON, resource, signIn, tokenURL, verifyIDToken, waitFor } from './auth.js';
import type { Registration, Tokens } from './auth.js';
import { CodexError, diagnosticIdentifier, errorEvent, failureLog, localError, object, reportedQuota, safeError, terminalAuthCodes } from './errors.js';
import type { CodexErrorEvent, Diagnostics, Stage } from './errors.js';
import { conservativeModelLimits, resolveFamilyModelLimits, resolveMaxOutputTokens, resolveModelLimits } from './model-limits.js';
import { fromResponsesJSON, fromResponsesStream, sniffResponsesBody, toResponsesRequest } from './protocol.js';

export interface CodexProviderOptions {
  host: AuthHost;
  agentName: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export function createCodexProvider(options: CodexProviderOptions): SubscriptionProvider {
  return new CodexProvider(options);
}

class CodexProvider implements SubscriptionProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex (ChatGPT plan)';
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #registration: Registration | undefined;
  #tokens: Tokens | undefined;
  #clientId: string | undefined;
  #state: ConnectionState = { status: 'disconnected' };
  #loaded: Promise<void> | undefined;
  #refresh: Promise<Tokens> | undefined;
  #connecting: Promise<void> | undefined;
  #lifetime = new AbortController();
  #disposed = false;
  #disconnecting = false;
  #models: { key: string; expiresAt: number; value: readonly ModelDescriptor[] } | undefined;
  #modelsPending: { key: string; promise: Promise<readonly ModelDescriptor[]> } | undefined;
  #modelsGeneration = 0;

  #clearModels(): void {
    this.#models = undefined;
    this.#modelsPending = undefined;
    this.#modelsGeneration++;
  }

  constructor(readonly options: CodexProviderOptions) {
    if (!options.agentName.trim()) throw localError('sign-in', 'Codex agentName must be a real product name');
    const fetcher = options.fetch ?? globalThis.fetch;
    this.#fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      // No query string, origin, headers or body (OAuth URLs contain secrets).
      const knownPaths = ['/v1/models', '/v1/responses', '/api/accounts/oauth/token', '/.well-known/jwks.json', '/.well-known/openid-configuration'];
      const loggedPath = knownPaths.includes(path) ? path : '[redacted-path]';
      const started = Date.now();
      options.logger?.info(`ChatGPT request method=${init.method ?? 'GET'} path=${loggedPath}`);
      const retryStage = String(url) === `${resource}/models` && (init.method ?? 'GET') === 'GET' ? 'models'
        : String(url) === `${resource}/responses` && init.method === 'POST' ? 'responses'
        : String(url) === tokenURL && init.method === 'POST'
          && new URLSearchParams(String(init.body)).get('grant_type') === 'refresh_token' ? 'refresh' : undefined;
      let response: Response;
      const backoff = [300, 1000];
      for (let attempt = 0; ; attempt++) {
        init.signal?.throwIfAborted();
        try { response = await fetcher(url, init); break; }
        catch (error) {
          if (!retryStage || init.signal?.aborted) throw error;
          const wait = backoff[attempt];
          if (wait === undefined) throw localError(retryStage, 'ChatGPT network request failed', 'network_error');
          options.logger?.warn(`ChatGPT retrying after network error attempt=${attempt + 2} path=${loggedPath}`);
          await delay(wait, undefined, init.signal ? { signal: init.signal } : {});
        }
      }
      options.logger?.info(`ChatGPT response path=${loggedPath} status=${response.status} elapsedMs=${Date.now() - started}`);
      return response;
    };
    this.#now = options.now ?? Date.now;
  }

  #assertHost(host: AuthHost): void {
    if (host !== this.options.host) throw this.#failure(localError('sign-in', 'Codex AuthHost must match the configured host instance'), 'sign-in');
  }

  #failure(error: unknown, stage: Stage, cancelled = false, status = 0): CodexError {
    const failure = safeError(error, stage, cancelled, status);
    this.options.logger?.warn(failureLog(failure.event));
    return failure;
  }

  #load(): Promise<void> {
    return this.#loaded ??= (async () => {
      try {
        const secrets = this.options.host.secrets;
        this.#clientId = await secrets.get(keys.clientId);
        const registration = await secrets.get(keys.registration);
        const tokens = await secrets.get(keys.tokens);
        if (registration) {
          const value = object(JSON.parse(registration));
          if (value.clientId !== this.#clientId || typeof value.subject !== 'string' || !value.subject
            || typeof value.accountLabel !== 'string' || !this.#clientId?.startsWith('oaiapp_')) throw localError('sign-in', 'Saved ChatGPT registration is invalid.', 'invalid_saved_registration');
          this.#registration = value as unknown as Registration;
        }
        if (tokens && this.#registration) {
          const value = object(JSON.parse(tokens));
          if (typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string'
            || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || !Array.isArray(value.scopes)
            || !value.scopes.includes('chatgpt.tokens.use.direct')) throw localError('sign-in', 'Saved ChatGPT credentials are invalid.', 'invalid_saved_credentials');
          this.#tokens = value as unknown as Tokens;
          this.#state = { status: 'connected', accountLabel: this.#registration.accountLabel };
        }
      } catch (error) {
        this.#tokens = undefined;
        this.#state = { status: 'reauthentication-required', message: 'Saved ChatGPT credentials are invalid. Sign in again.' };
        this.#failure(error instanceof CodexError ? error : localError('sign-in', 'Saved ChatGPT credentials could not be loaded. Sign in again.', 'saved_credentials_unavailable'), 'sign-in');
      }
    })();
  }

  async getConnectionState(): Promise<ConnectionState> { await this.#load(); return structuredClone(this.#state); }

  async connect(host: AuthHost, signal: AbortSignal): Promise<void> {
    this.#assertHost(host);
    if (this.#disposed || this.#disconnecting) throw this.#failure(localError('sign-in', 'Codex provider is not available'), 'sign-in');
    if (this.#connecting) throw this.#failure(localError('sign-in', 'ChatGPT sign-in is already in progress'), 'sign-in');
    this.#clearModels();
    const combined = AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(5 * 60_000)]);
    this.#connecting = (async () => {
      let prior = this.#state;
      try {
        await this.#load();
        prior = this.#state;
        if (this.#refresh) await waitFor(this.#refresh, combined);
        combined.throwIfAborted();
        this.#state = { status: 'connecting' };
        this.options.logger?.info('ChatGPT sign-in started.');
        const result = await signIn({ host, agentName: this.options.agentName, fetcher: this.#fetch, now: this.#now, signal: combined,
          ...(this.#clientId ? { clientId: this.#clientId } : {}),
          ...(this.#registration ? { registration: this.#registration } : {}),
          ...(this.#tokens ? { tokens: this.#tokens } : {}),
        });
        this.#clientId = result.registration.clientId;
        this.#registration = result.registration;
        this.#tokens = result.tokens;
        this.#state = { status: 'connected', accountLabel: result.registration.accountLabel };
        this.options.logger?.info('ChatGPT sign-in completed.');
      } catch (error) {
        try { this.#clientId = await host.secrets.get(keys.clientId); }
        catch { this.#failure(localError('sign-in', 'Saved ChatGPT client registration could not be loaded.', 'saved_registration_unavailable'), 'sign-in'); }
        this.#state = prior;
        throw this.#failure(error, 'sign-in', combined.aborted);
      }
    })();
    try { await this.#connecting; } finally { this.#connecting = undefined; }
  }

  async #authenticationRequired(message: string): Promise<void> {
    this.#clearModels();
    this.#tokens = undefined;
    this.#state = { status: 'reauthentication-required', message };
    await this.options.host.secrets.delete(keys.tokens);
  }

  async #recordError(event: CodexErrorEvent, body: unknown, status = 0): Promise<void> {
    this.#clearModels();
    if (status === 401 || terminalAuthCodes.has(event.code) || event.code === 'subscription_sharing_invalid_user') {
      await this.#authenticationRequired('ChatGPT authentication could not be accepted. Sign in again.');
    } else if (this.#registration && this.#tokens) {
      const { type: _, ...error } = event;
      this.#state = { status: 'connected', accountLabel: this.#registration.accountLabel, error,
        ...(event.code === 'subscription_sharing_usage_limit_exceeded' ? { quota: reportedQuota(body) } : {}) };
    }
  }

  async #access(signal: AbortSignal): Promise<Tokens> {
    if (this.#disposed || this.#disconnecting) throw localError('refresh', 'Codex provider is not available');
    await waitFor(this.#load(), signal);
    if (this.#connecting) throw localError('sign-in', 'ChatGPT sign-in is in progress');
    if (!this.#tokens || !this.#registration) throw localError('sign-in', 'Sign in with ChatGPT before making requests.', 'reauthentication_required');
    if (this.#tokens.expiresAt > this.#now() + 60_000) return this.#tokens;
    if (!this.#refresh) {
      const current = this.#tokens;
      const registration = this.#registration;
      const refreshSignal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]);
      this.#refresh = (async () => {
        let status = 0;
        try {
          this.options.logger?.info('ChatGPT refresh started.');
          const body = await requestJSON(this.#fetch, tokenURL, {
            method: 'POST', signal: refreshSignal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.clientId, refresh_token: current.refreshToken, resource }).toString(),
          }, 'refresh');
          status = 200;
          const tokens = parseTokens(body, this.#now(), current, 'refresh', status);
          if (typeof body.id_token === 'string') {
            const identity = await verifyIDToken(body.id_token, registration.clientId, undefined, this.#fetch, this.#now(), refreshSignal, 'refresh');
            if (identity.subject !== registration.subject) throw localError('refresh', 'ChatGPT refresh returned a different account', 'account_mismatch', status);
          }
          refreshSignal.throwIfAborted();
          await this.options.host.secrets.store(keys.tokens, JSON.stringify(tokens));
          refreshSignal.throwIfAborted();
          this.#tokens = tokens;
          this.options.logger?.info('ChatGPT refresh completed.');
          return tokens;
        } catch (error) {
          const failure = this.#failure(error, 'refresh', refreshSignal.aborted, status);
          try { await this.#recordError(failure.event, failure.body, failure.status); }
          catch { this.#failure(localError('refresh', 'ChatGPT credential state could not be updated.'), 'refresh'); }
          throw failure;
        }
      })().finally(() => { this.#refresh = undefined; });
    }
    // A cancelled waiter never cancels a rotating refresh needed by other requests.
    return waitFor(this.#refresh, signal);
  }

  async listModels(signal: AbortSignal, options: { force?: boolean } = {}): Promise<readonly ModelDescriptor[]> {
    const combined = AbortSignal.any([signal, this.#lifetime.signal]);
    // Access first so expiry/failed refresh cannot be hidden by a cached catalog.
    try { await this.#access(combined); }
    catch (error) { throw this.#failure(error, 'models', combined.aborted); }
    combined.throwIfAborted();
    const key = JSON.stringify([this.#registration?.clientId, this.#registration?.subject]);
    if (!options.force && this.#models?.key === key && this.#models.expiresAt > this.#now()) {
      return structuredClone(this.#models.value);
    }
    if (this.#modelsPending?.key === key) return structuredClone(await waitFor(this.#modelsPending.promise, combined));
    const generation = this.#modelsGeneration;
    // Cancelling a waiter must not cancel a catalog needed by other callers.
    const promise = this.#listModels(AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]));
    const pending = { key, promise };
    this.#modelsPending = pending;
    void promise.then(value => {
      if (generation === this.#modelsGeneration) this.#models = { key, value, expiresAt: this.#now() + 10 * 60_000 };
    }).finally(() => {
      if (this.#modelsPending === pending) this.#modelsPending = undefined;
    }).catch(() => {});
    return structuredClone(await waitFor(promise, combined));
  }

  async #listModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
    const combined = AbortSignal.any([signal, this.#lifetime.signal]);
    try {
      const tokens = await this.#access(combined);
      const body = await requestJSON(this.#fetch, `${resource}/models`, { signal: combined, headers: { Authorization: `Bearer ${tokens.accessToken}` } }, 'models');
      if (!Array.isArray(body.models)) throw localError('models', 'ChatGPT returned an invalid model catalog', 'invalid_model_catalog', 200);
      return body.models.map(object).filter(model => model.visibility === 'list' && model.supported_in_api === true).map(model => {
        if (typeof model.slug !== 'string' || typeof model.display_name !== 'string'
          || !Array.isArray(model.input_modalities)) throw localError('models', 'ChatGPT returned an invalid model catalog', 'invalid_model_catalog', 200);
        const limits = resolveModelLimits(model.slug) ?? resolveFamilyModelLimits(model.slug) ?? conservativeModelLimits;
        const contextWindow = model.context_window ?? limits.contextWindow;
        if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 2) throw localError('models', 'ChatGPT returned an invalid model catalog', 'invalid_model_catalog', 200);
        // Prefer the SIWC context window. Reserve at least one input token if
        // its window is smaller than the public output cap; VS Code subtracts
        // maxOutputTokens from contextWindow to obtain its input budget.
        const maxOutputTokens = Math.min(resolveMaxOutputTokens(model.slug) ?? limits.maxOutputTokens, contextWindow - 1);
        const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
        const efforts = levels.map(level => typeof level === 'string' ? level : object(level).effort).filter((value): value is string => typeof value === 'string');
        return { providerId: this.id, modelId: model.slug, name: model.display_name, contextWindow,
          maxOutputTokens, capabilities: { tools: true, images: model.input_modalities.includes('image'), reasoningEfforts: efforts } };
      });
    } catch (error) {
      const failure = this.#failure(error, 'models', combined.aborted);
      try { await this.#recordError(failure.event, failure.body, failure.status); }
      catch { this.#failure(localError('models', 'ChatGPT credential state could not be updated.'), 'models'); }
      throw failure;
    }
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
    let stage: Stage = 'convert';
    let status = 0;
    let contentType: string | null | undefined;
    const sniffDiagnostics: Pick<Diagnostics, 'sniff' | 'contentTypeMissing' | 'bodyKind'> = {};
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      signal.throwIfAborted();
      const body = toResponsesRequest(request);
      const encoded = JSON.stringify(body);
      stage = 'responses';
      const tokens = await this.#access(signal);
      this.options.logger?.info(`ChatGPT responses model=${diagnosticIdentifier(request.model.modelId, true) ?? '[redacted]'} input=${(body.input as unknown[]).length} tools=${request.tools.length} image=${request.messages.some(message => message.content.some(part => part.type === 'image'))}`);
      let response: Response;
      try { response = await this.#fetch(`${resource}/responses`, {
        method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: encoded,
      }); } catch { throw localError('responses', 'ChatGPT network request failed', 'network_error'); }
      status = response.status;
      responseBody = response.body;
      signal.throwIfAborted();
      if (!response.ok) {
        let failure: unknown;
        try { failure = await response.json(); } catch { failure = undefined; }
        throw new CodexError(errorEvent(failure, response.status), response.status, failure);
      }
      contentType = response.headers.get('content-type');
      const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
      let bodyKind = mediaType === 'text/event-stream' ? 'sse' : mediaType === 'application/json' ? 'json' : 'unknown';
      if (!responseBody || mediaType !== 'text/event-stream') {
        this.options.logger?.warn(`ChatGPT non-SSE response ${JSON.stringify({
          contentType, contentEncoding: response.headers.get('content-encoding'),
          contentLength: response.headers.get('content-length'), transferEncoding: response.headers.get('transfer-encoding'),
          bodyNull: response.body === null,
        })}`);
        if (responseBody && mediaType !== 'application/json' && mediaType !== 'text/event-stream') {
          const sniffed = await sniffResponsesBody(responseBody, signal);
          responseBody = sniffed.body;
          bodyKind = sniffed.kind;
          sniffDiagnostics.sniff = sniffed.kind;
          sniffDiagnostics.contentTypeMissing = contentType === null;
          if (sniffed.kind === 'html' || sniffed.kind === 'unknown') sniffDiagnostics.bodyKind = sniffed.kind;
          this.options.logger?.warn(`ChatGPT response sniff ${JSON.stringify(sniffDiagnostics)}`);
        }
        if (bodyKind === 'json' && responseBody) {
          let value: Record<string, unknown>;
          try {
            const jsonResponse = new Response(responseBody);
            value = object(sniffDiagnostics.sniff === 'json'
              ? JSON.parse((await jsonResponse.text()).trimStart()) : await jsonResponse.json());
          }
          catch { throw localError('responses', 'ChatGPT returned malformed JSON instead of SSE; a proxy or gateway may have intercepted the request.', 'invalid_stream', status); }
          signal.throwIfAborted();
          const upstream = object(value.error);
          const reason = diagnosticIdentifier(object(value.incomplete_details).reason);
          this.options.logger?.warn(`ChatGPT JSON response ${JSON.stringify({
            object: diagnosticIdentifier(value.object), status: diagnosticIdentifier(value.status),
            error: { code: diagnosticIdentifier(upstream.code), type: diagnosticIdentifier(upstream.type), param: diagnosticIdentifier(upstream.param, true) },
            incomplete_details: { reason },
          })}`);
          if (value.object === 'response' && value.status === 'completed') {
            for (const event of fromResponsesJSON(value)) {
              signal.throwIfAborted();
              if (event.type === 'finish' && this.#registration && this.#tokens) {
                this.#state = { status: 'connected', accountLabel: this.#registration.accountLabel };
              }
              yield event;
            }
            return;
          }
          if (value.error || (value.object === 'response' && (value.status === 'failed' || value.status === 'incomplete'))) {
            const event = value.status === 'incomplete' && !upstream.code
              ? localError('responses', 'ChatGPT returned an incomplete response.', 'response_incomplete', status).event
              : errorEvent(value, status);
            if (reason) event.diagnostics.incompleteReason = reason;
            throw new CodexError(event, status, value);
          }
        }
        if (!responseBody || bodyKind !== 'sse') {
          throw localError('responses', bodyKind === 'html'
            ? 'ChatGPT returned HTML instead of a Responses stream; a proxy or gateway may have intercepted the request.'
            : 'ChatGPT did not return a Responses stream; a proxy or gateway may have intercepted the request.', 'invalid_stream', status);
        }
      }
      stage = 'stream';
      for await (const event of fromResponsesStream(responseBody!, signal, async (event, failure) => {
        event.diagnostics.status ??= status;
        Object.assign(event.diagnostics, sniffDiagnostics);
        this.options.logger?.warn(failureLog(event));
        try { await this.#recordError(event, failure, status); }
        catch { this.#failure(localError('stream', 'ChatGPT credential state could not be updated.', 'state_update_failed', status), 'stream'); }
      }, stats => this.options.logger?.info(`ChatGPT SSE ended ${JSON.stringify(stats)}`), sniffDiagnostics.sniff === 'sse')) {
        signal.throwIfAborted();
        if (event.type === 'finish' && this.#registration && this.#tokens) {
          this.#state = { status: 'connected', accountLabel: this.#registration.accountLabel };
        }
        yield event;
      }
    } catch (error) {
      const safe = safeError(error, stage, signal.aborted, status);
      Object.assign(safe.diagnostics, sniffDiagnostics);
      if (contentType !== undefined && stage === 'responses') safe.diagnostics.contentType = contentType;
      const failure = this.#failure(safe, stage, signal.aborted, status);
      if (signal.aborted) throw failure;
      try { await this.#recordError(failure.event, failure.body, failure.status); }
      catch { this.#failure(localError(stage, 'ChatGPT credential state could not be updated.', 'state_update_failed', status), stage); }
      yield failure.event;
    } finally {
      // Covers rejected sniffed bodies and JSON failures as well as early consumer return.
      if (responseBody && !responseBody.locked) await responseBody.cancel().catch(() => {});
    }
  }

  async disconnect(host: AuthHost): Promise<void> {
    this.#assertHost(host);
    if (this.#disconnecting) throw this.#failure(localError('sign-in', 'ChatGPT sign-out is already in progress'), 'sign-in');
    this.#disconnecting = true;
    this.#clearModels();
    this.#lifetime.abort();
    let revocationFailure: CodexError | undefined;
    try {
      await this.#load();
      await Promise.allSettled([this.#connecting, this.#refresh].filter((value): value is Promise<void> | Promise<Tokens> => value !== undefined));
      if (this.#tokens && this.#registration) {
        try {
          const signal = AbortSignal.timeout(15_000);
          const configuration = await requestJSON(this.#fetch, `${issuer}/.well-known/openid-configuration`, { signal });
          if (typeof configuration.revocation_endpoint !== 'string') throw localError('sign-in', 'ChatGPT returned an invalid revocation endpoint');
          const endpoint = new URL(configuration.revocation_endpoint);
          if (endpoint.origin !== issuer || endpoint.username || endpoint.password) throw localError('sign-in', 'ChatGPT returned an invalid revocation endpoint');
          const response = await this.#fetch(endpoint, { method: 'POST', signal, redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: this.#tokens.refreshToken, token_type_hint: 'refresh_token', client_id: this.#registration.clientId }).toString() });
          if (response.status !== 200) {
            let failure: unknown;
            try { failure = await response.json(); } catch { failure = undefined; }
            throw new CodexError(errorEvent(failure, response.status, 'sign-in'), response.status);
          }
        } catch (error) { revocationFailure = this.#failure(error, 'sign-in'); }
      }
      await host.secrets.delete(keys.tokens);
      this.#tokens = undefined;
      this.#state = { status: 'disconnected' };
    } catch (error) {
      throw this.#failure(error, 'sign-in');
    } finally {
      if (!this.#disposed) this.#lifetime = new AbortController();
      this.#disconnecting = false;
    }
    if (revocationFailure) {
      const summary = 'Signed out locally; remote revocation was not confirmed. Disconnect the app in ChatGPT settings.';
      const event = { ...revocationFailure.event, message: summary, diagnostics: { ...revocationFailure.diagnostics, summary } };
      throw this.#failure(new CodexError(event), 'sign-in');
    }
  }

  async dispose(): Promise<void> {
    this.#clearModels();
    this.#disposed = true;
    this.#lifetime.abort();
    await Promise.allSettled([this.#connecting, this.#refresh].filter((value): value is Promise<void> | Promise<Tokens> => value !== undefined));
  }
}
