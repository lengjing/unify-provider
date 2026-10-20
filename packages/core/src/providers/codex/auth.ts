import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AuthHost } from '../../core/provider.js';
import { CodexError, errorEvent, localError, object, safeError } from './errors.js';
import type { Stage } from './errors.js';

export const issuer = 'https://auth.openai.com';
export const resource = 'https://api.openai.com/v1';
export const tokenURL = `${issuer}/api/accounts/oauth/token`;
export const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const keys = {
  hostId: 'codex.siwc.host-id', clientId: 'codex.siwc.client-id',
  registration: 'codex.siwc.registration', tokens: 'codex.siwc.tokens',
} as const;

export interface Registration { clientId: string; subject: string; accountLabel: string }
export interface Tokens {
  accessToken: string; refreshToken: string; idToken?: string;
  expiresAt: number; scopes: string[];
}

export async function waitFor<T>(promise: Promise<T>, signal: AbortSignal, stage: Stage = 'refresh'): Promise<T> {
  if (signal.aborted) throw safeError(undefined, stage, true);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(localError(stage, 'The ChatGPT operation was cancelled.', 'operation_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { const value = await Promise.race([promise, cancelled]); if (signal.aborted) throw safeError(undefined, stage, true); return value; }
  finally { signal.removeEventListener('abort', abort); }
}

export async function requestJSON(fetcher: typeof fetch, url: string, init: RequestInit, stage: Stage = 'sign-in'): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error' }); }
  catch { throw localError(stage, init.signal?.aborted ? 'The ChatGPT operation was cancelled.' : 'ChatGPT network request failed', init.signal?.aborted ? 'operation_cancelled' : 'network_error'); }
  let body: unknown;
  try { body = await response.json(); } catch {
    if (response.ok) throw localError(stage, 'ChatGPT returned invalid JSON.', 'invalid_json', response.status);
    body = undefined;
  }
  if (init.signal?.aborted) throw localError(stage, 'The ChatGPT operation was cancelled.', 'operation_cancelled', response.status);
  if (!response.ok) throw new CodexError(errorEvent(body, response.status, stage), response.status, body);
  return object(body);
}

export function parseTokens(body: Record<string, unknown>, now: number, previous?: Tokens, stage: Stage = 'sign-in', status = 0): Tokens {
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!scopes?.includes('chatgpt.tokens.use.direct')) throw localError(stage, 'ChatGPT plan usage permission was not granted', 'missing_plan_scope', status);
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token
    || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw localError(stage, 'ChatGPT returned an invalid token response', 'invalid_auth_response', status);
  }
  const idToken = typeof body.id_token === 'string' ? body.id_token : previous?.idToken;
  return { accessToken: body.access_token, refreshToken: body.refresh_token, scopes,
    expiresAt: now + body.expires_in * 1000, ...(idToken ? { idToken } : {}) };
}

/** Pinned issuer/JWKS, RS256 only; untrusted JWT fields never select a URL. */
export async function verifyIDToken(token: string, clientId: string, nonce: string | undefined, fetcher: typeof fetch, now: number, signal: AbortSignal, stage: Stage = 'sign-in'): Promise<Registration> {
  try {
    const segments = token.split('.');
    if (segments.length !== 3) throw localError(stage, 'ChatGPT returned an invalid ID token: malformed JWT.', 'invalid_id_token');
    const [headerPart, payloadPart, signaturePart] = segments as [string, string, string];
    const header = object(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')));
    const claims = object(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw localError(stage, 'ChatGPT returned an invalid ID token: unsupported JWT header.', 'invalid_id_token');
    const jwks = await requestJSON(fetcher, `${issuer}/.well-known/jwks.json`, { signal }, stage);
    if (!Array.isArray(jwks.keys)) throw localError(stage, 'ChatGPT returned an invalid ID token: invalid signing key catalog.', 'invalid_id_token', 200);
    const candidates = jwks.keys.map(object).filter(jwk => jwk.kid === header.kid && jwk.kty === 'RSA'
      && (jwk.alg === undefined || jwk.alg === 'RS256') && (jwk.use === undefined || jwk.use === 'sig'));
    if (candidates.length !== 1) throw localError(stage, 'ChatGPT returned an invalid ID token: signing key not uniquely matched.', 'invalid_id_token', 200);
    const key = await webcrypto.subtle.importKey('jwk', candidates[0] as webcrypto.JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(signaturePart, 'base64url'), Buffer.from(`${headerPart}.${payloadPart}`));
    const audience = claims.aud;
    if (!valid || claims.iss !== issuer || !(audience === clientId || (Array.isArray(audience) && audience.includes(clientId)))
      || (Array.isArray(audience) && audience.length > 1 && claims.azp !== clientId)
      || (claims.azp !== undefined && claims.azp !== clientId)
      || typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || claims.exp * 1000 <= now
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isInteger(claims.nbf) || claims.nbf * 1000 > now))
       || (nonce !== undefined && claims.nonce !== nonce) || typeof claims.sub !== 'string' || !claims.sub.trim()) throw localError(stage, 'ChatGPT returned an invalid ID token: signature or identity claims rejected.', 'invalid_id_token', 200);
    const profile = object(claims['https://api.openai.com/profile']);
    const label = [claims.email, profile.email, claims.name, profile.name].find(value => typeof value === 'string' && value.trim());
    return { clientId, subject: claims.sub, accountLabel: typeof label === 'string' ? label : claims.sub };
  } catch (error) {
    if (error instanceof CodexError) throw error;
    if (signal.aborted) throw safeError(error, stage, true);
    throw localError(stage, 'ChatGPT returned an invalid ID token: JWT decoding or cryptographic validation failed.', 'invalid_id_token');
  }
}

export async function signIn(options: {
  host: AuthHost; agentName: string; fetcher: typeof fetch; now: () => number; signal: AbortSignal;
  clientId?: string; registration?: Registration; tokens?: Tokens;
}): Promise<{ registration: Registration; tokens: Tokens }> {
  try { return await performSignIn(options); }
  catch (error) { throw safeError(error, 'sign-in', options.signal.aborted); }
}

async function performSignIn(options: Parameters<typeof signIn>[0]): Promise<{ registration: Registration; tokens: Tokens }> {
  const { host, signal } = options;
  signal.throwIfAborted();
  let hostId = await host.secrets.get(keys.hostId);
  if (!hostId) { hostId = `urn:uuid:${randomUUID()}`; await host.secrets.store(keys.hostId, hostId); }
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let resolveCallback!: (value: { code: string; clientId: string; response: ServerResponse }) => void;
  let rejectCallback!: (reason: Error) => void;
  let received = false;
  const callback = new Promise<{ code: string; clientId: string; response: ServerResponse }>((resolve, reject) => {
    resolveCallback = resolve; rejectCallback = reject;
  });
  // Callback rejection can precede browser opening completing.
  void callback.catch(() => {});
  const page = (response: ServerResponse, success: boolean) => response.writeHead(success ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  }).end(`<!doctype html><title>ChatGPT sign-in</title><p>${success ? 'Sign-in complete. You can close this window.' : 'Sign-in failed. Return to the app.'}</p>`);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found'); return; }
    if (received) { response.writeHead(409).end('Callback already received'); return; }
    received = true;
    const returnedId = url.searchParams.get('client_id');
    const clientId = options.clientId ?? returnedId;
    const code = url.searchParams.get('code');
    if (request.method !== 'GET' || url.searchParams.get('state') !== state || url.searchParams.has('error') || !code
      || !clientId?.startsWith('oaiapp_') || (options.clientId && returnedId && returnedId !== options.clientId)) {
      page(response, false);
      rejectCallback(localError('sign-in', 'ChatGPT callback was rejected'));
      return;
    }
    resolveCallback({ code, clientId, response });
  });
  const onAbort = () => {
    rejectCallback(localError('sign-in', 'The ChatGPT operation was cancelled.', 'operation_cancelled'));
    server.close(); server.closeAllConnections();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let response: ServerResponse | undefined;
  let persistenceStarted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(localError('sign-in', 'Could not start ChatGPT callback listener')));
      server.listen(0, '127.0.0.1', resolve);
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string') throw localError('sign-in', 'Missing ChatGPT callback port');
    const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: options.clientId ?? 'dynamic_agent_client',
      ...(options.clientId ? {} : { agent_name_hint: options.agentName }),
      ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope, resource, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(options.clientId && options.tokens?.idToken ? { id_token_hint: options.tokens.idToken } : {}),
    }).toString();
    try { await waitFor(host.openExternal(url), signal, 'sign-in'); } catch { signal.throwIfAborted(); throw localError('sign-in', 'Could not open ChatGPT sign-in browser'); }
    const result = await callback;
    response = result.response;
    signal.throwIfAborted();
    // Retain registration after code failure; never persist the dynamic entrypoint.
    if (!options.clientId) await host.secrets.store(keys.clientId, result.clientId);
    const body = await requestJSON(options.fetcher, tokenURL, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code,
        code_verifier: verifier, redirect_uri: redirect, resource }).toString(),
    });
    const tokens = parseTokens(body, options.now(), undefined, 'sign-in', 200);
    if (!tokens.idToken) throw localError('sign-in', 'ChatGPT did not return an ID token', 'missing_id_token', 200);
    const registration = await verifyIDToken(tokens.idToken, result.clientId, nonce, options.fetcher, options.now(), signal);
    if (options.registration && registration.subject !== options.registration.subject) throw localError('sign-in', 'ChatGPT returned a different account', 'account_mismatch', 200);
    signal.throwIfAborted();
    // A successful browser page means validation and protected persistence really succeeded.
    persistenceStarted = true;
    await host.secrets.store(keys.registration, JSON.stringify(registration));
    await host.secrets.store(keys.tokens, JSON.stringify(tokens));
    signal.throwIfAborted();
    page(response, true);
    return { registration, tokens };
  } catch (error) {
    if (response && !response.writableEnded && !response.destroyed) page(response, false);
    // Best-effort compensation: a failed/cancelled attempt must not activate its new tokens.
    if (persistenceStarted) {
      await (options.tokens ? host.secrets.store(keys.tokens, JSON.stringify(options.tokens)) : host.secrets.delete(keys.tokens));
      await (options.registration ? host.secrets.store(keys.registration, JSON.stringify(options.registration)) : host.secrets.delete(keys.registration));
    }
    signal.throwIfAborted();
    throw safeError(error, 'sign-in', signal.aborted);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
