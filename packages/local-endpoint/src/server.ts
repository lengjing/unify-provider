import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ModelDescriptor, ProviderRegistry } from '@unify-provider/core';
import { assemble, ChatCompletionsError, convertRequest, toChunks } from './chat-completions.js';
import type { ChatCompletionChunk, StreamOutcome } from './chat-completions.js';

export interface LocalEndpointLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface LocalEndpointOptions {
  registry: ProviderRegistry;
  providerId: string;
  /** Bearer token the editor must present; generated and stored by the hosting plugin. */
  token: string;
  /** Preferred port; 0 lets the OS choose. Binding is always 127.0.0.1. */
  port?: number;
  maxBodyBytes?: number;
  logger?: LocalEndpointLogger;
}

export interface LocalEndpoint {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const loopback = '127.0.0.1';
const defaultMaxBody = 32 * 1024 * 1024;
const noop: LocalEndpointLogger = { info() {}, warn() {} };

/** Bounded identifier for logs; never free-form client input. */
const safeId = (value: string): string => /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : '[redacted]';

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = header !== undefined ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match) return false;
  const provided = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, type = 'invalid_request_error'): void {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

/** Map a provider-reported failure to an HTTP status the editor can interpret. */
function statusFor(code: string, retryable: boolean): number {
  if (/429|usage_limit|rate_limit|quota/i.test(code)) return 429;
  if (/401|reauthentication|invalid_grant|invalid_user|refresh_token|token_expired|authentication/i.test(code)) return 401;
  if (/403|forbidden|not_eligible|ineligible|scope_not_authorized/i.test(code)) return 403;
  if (/operation_cancelled/i.test(code)) return 499;
  if (/invalid_response|incomplete_response/i.test(code)) return 502;
  return retryable ? 503 : 502;
}

function failureFromThrown(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ChatCompletionsError) return { status: error.status, code: error.code, message: error.message };
  const source = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const event = typeof source.event === 'object' && source.event !== null ? source.event as Record<string, unknown> : {};
  const code = typeof event.code === 'string' ? event.code : typeof source.code === 'string' ? source.code : 'provider_error';
  const redacted = source.redacted === true;
  // Only trusted (redacted) provider messages are returned; unknown exceptions could echo secrets.
  const message = redacted && error instanceof Error ? error.message : 'The model request failed. Check the Unify Provider output log in the editor.';
  return { status: statusFor(code, event.retryable === true), code, message };
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new ChatCompletionsError(413, 'request_too_large', `Request body exceeds ${limit} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class ModelCatalog {
  private cache: { fetchedAt: number; models: readonly ModelDescriptor[] } | undefined;
  private refreshing: Promise<readonly ModelDescriptor[]> | undefined;
  constructor(private readonly registry: ProviderRegistry, private readonly providerId: string) {}

  invalidate(): void { this.cache = undefined; }

  /** Serve a cached catalog without blocking the request; refresh in the background when stale. */
  async list(): Promise<readonly ModelDescriptor[]> {
    if (this.cache) {
      if (Date.now() - this.cache.fetchedAt > staleAfterMs) void this.refresh().catch(() => {});
      return this.cache.models;
    }
    return this.refresh();
  }

  async refresh(): Promise<readonly ModelDescriptor[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const provider = this.registry.get(this.providerId);
      const state = await provider.getConnectionState();
      if (state.status === 'reauthentication-required') {
        throw new ChatCompletionsError(401, 'reauthentication_required', 'The ChatGPT authorization expired. Sign in again from Unify Provider in the editor.');
      }
      if (state.status !== 'connected') {
        throw new ChatCompletionsError(503, 'not_connected', 'Unify Provider is not connected. Run "Unify Provider: Sign in with ChatGPT" in the editor first.');
      }
      const models = await provider.listModels(AbortSignal.timeout(30_000));
      this.cache = { fetchedAt: Date.now(), models };
      return models;
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
}
const staleAfterMs = 10 * 60_000;

export async function startLocalEndpoint(options: LocalEndpointOptions): Promise<LocalEndpoint> {
  if (!options.token || options.token.length < 16) throw new Error('Local endpoint token must be at least 16 characters.');
  const logger = options.logger ?? noop;
  const limit = options.maxBodyBytes ?? defaultMaxBody;
  const catalog = new ModelCatalog(options.registry, options.providerId);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${loopback}`);
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '').replace(/\/+$/, '') || '/';
    if (req.socket.remoteAddress !== loopback && req.socket.remoteAddress !== `::ffff:${loopback}`) {
      req.destroy();
      return;
    }
    if (!tokenMatches(req.headers.authorization, options.token)) {
      logger.warn(`Local endpoint rejected ${req.method ?? '?'} ${safeId(path)}: invalid or missing bearer token`);
      sendError(res, 401, 'invalid_api_key', 'Invalid API key. Copy the current key from Unify Provider in the editor.', 'authentication_error');
      return;
    }
    try {
      if (path === '/models' && req.method === 'GET') {
        const models = await catalog.list();
        sendJson(res, 200, { object: 'list', data: models.map(model => ({ id: model.modelId, object: 'model', created: 0, owned_by: 'unify-provider' })) });
        logger.info(`Local endpoint GET /models -> 200 models=${models.length} elapsedMs=${Date.now() - started}`);
        return;
      }
      if (path === '/chat/completions' && req.method === 'POST') {
        await completions(req, res, started);
        return;
      }
      sendError(res, 404, 'not_found', `Unsupported route ${req.method ?? ''} ${path}. Use POST /v1/chat/completions or GET /v1/models.`);
    } catch (error) {
      const failure = failureFromThrown(error);
      if (failure.status === 401) catalog.invalidate();
      logger.warn(`Local endpoint ${req.method ?? '?'} ${safeId(path)} failed status=${failure.status} code=${safeId(failure.code)} elapsedMs=${Date.now() - started}`);
      if (!res.headersSent) sendError(res, failure.status, failure.code, failure.message, failure.status === 401 ? 'authentication_error' : 'server_error');
      else res.end();
    }
  };

  const completions = async (req: IncomingMessage, res: ServerResponse, started: number): Promise<void> => {
    let body: unknown;
    try { body = JSON.parse(await readBody(req, limit)); }
    catch (error) {
      if (error instanceof ChatCompletionsError) throw error;
      throw new ChatCompletionsError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
    const requestedModel = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).model : undefined;
    if (typeof requestedModel !== 'string' || !requestedModel) throw new ChatCompletionsError(400, 'invalid_request_error', 'model must be a non-empty string.');
    let model = (await catalog.list()).find(candidate => candidate.modelId === requestedModel);
    // A newly added model may be missing from a stale catalog; refresh once before rejecting.
    if (!model) model = (await catalog.refresh()).find(candidate => candidate.modelId === requestedModel);
    if (!model) throw new ChatCompletionsError(404, 'model_not_found', 'Unknown model. Copy a model ID from Unify Provider in the editor.');
    const request = convertRequest(body, model);
    const controller = new AbortController();
    let settled = false;
    res.on('close', () => { if (!settled) controller.abort(); });
    const id = `chatcmpl-${randomBytes(12).toString('base64url')}`;
    const created = Math.floor(Date.now() / 1000);
    const events = options.registry.complete({
      model: { providerId: options.providerId, modelId: model.modelId },
      messages: request.messages, tools: request.tools, signal: controller.signal,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    });
    const stream = toChunks(events, id, model.modelId, created);
    logger.info(`Local endpoint chat.completions started model=${safeId(model.modelId)} messages=${request.messages.length} tools=${request.tools.length} stream=${request.stream}`);
    let outcome: StreamOutcome;
    let status = 200;
    const upstreamStarted = Date.now();
    let firstOutputAt: number | undefined;
    // First model output (text, reasoning or tool call), excluding the synthetic role chunk.
    const observe = (chunk: ChatCompletionChunk) => {
      if (firstOutputAt !== undefined) return;
      const delta = chunk.choices[0]!.delta;
      if (delta.content || delta.reasoning_content || delta.tool_calls) firstOutputAt = Date.now();
    };
    try {
      if (request.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive', 'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        outcome = await pump(stream, chunk => { observe(chunk); res.write(`data: ${JSON.stringify(chunk)}\n\n`); });
        if (outcome.kind === 'finished') {
          res.write('data: [DONE]\n\n');
        } else {
          status = statusFor(outcome.code, outcome.retryable);
          res.write(`data: ${JSON.stringify({ error: { message: outcome.message, type: 'server_error', code: outcome.code, param: null } })}\n\n`);
        }
        res.end();
      } else {
        const chunks: ChatCompletionChunk[] = [];
        outcome = await pump(stream, chunk => { observe(chunk); chunks.push(chunk); });
        if (outcome.kind === 'finished') sendJson(res, 200, assemble(chunks, id, model.modelId, created));
        else {
          status = statusFor(outcome.code, outcome.retryable);
          sendError(res, status, outcome.code, outcome.message, 'server_error');
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        status = 499;
        if (!res.headersSent) res.statusCode = 499;
        res.end();
      } else {
        const failure = failureFromThrown(error);
        status = failure.status;
        if (!res.headersSent) sendError(res, failure.status, failure.code, failure.message, 'server_error');
        else { res.write(`data: ${JSON.stringify({ error: { message: failure.message, type: 'server_error', code: failure.code, param: null } })}\n\n`); res.end(); }
      }
    } finally {
      settled = true;
      if (status === 401) catalog.invalidate();
      logger.info(`Local endpoint chat.completions ended status=${status} elapsedMs=${Date.now() - started} queueMs=${upstreamStarted - started} firstOutputMs=${firstOutputAt === undefined ? 'n/a' : firstOutputAt - upstreamStarted} upstreamMs=${Date.now() - upstreamStarted}`);
    }
  };

  const server: Server = createServer((req, res) => { void handle(req, res); });
  // Loopback-only; long generations must not be cut by the default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, loopback, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  logger.info(`Local endpoint listening on http://${loopback}:${port} (loopback only)`);
  return {
    url: `http://${loopback}:${port}`, port,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function pump(stream: AsyncGenerator<ChatCompletionChunk, StreamOutcome>, emit: (chunk: ChatCompletionChunk) => void): Promise<StreamOutcome> {
  for (;;) {
    const next = await stream.next();
    if (next.done) return next.value;
    emit(next.value);
  }
}
