import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { bearerToken, createKeySource, type KeySourceOptions } from './auth.ts';
import { env } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * Service-to-service calls on `/internal/**` (docs/v2/03-architecture.md §5). A service account is a
 * confidential Keycloak client with the client-credentials grant; its tokens carry `aud: routine-internal`
 * (never `routine-api`, so they open no user API) and `azp` = the client id = the service name.
 */
export const INTERNAL_AUDIENCE = 'routine-internal';
export const INTERNAL_PREFIX = '/internal/';

export interface ServiceCaller {
  /** The calling service, e.g. `integration-worker`. */
  service: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller: ServiceCaller | null;
  }
}

export interface ServiceTokenVerifier {
  verify(token: string): Promise<ServiceCaller>;
}

/** Verifies service tokens like user tokens (same keys, same issuer), but for the internal audience. */
export function createServiceTokenVerifier(jwksUrl: string, options: KeySourceOptions & { issuer?: string } = {}): ServiceTokenVerifier {
  const issuer = options.issuer ?? env('JWT_ISSUER');
  const keys = createKeySource(jwksUrl, options);
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, { issuer, audience: INTERNAL_AUDIENCE });
      if (typeof payload.azp !== 'string' || payload.azp === '') throw new Error('service token has no azp');
      return { service: payload.azp };
    },
  };
}

/**
 * Accepts `/internal/**` requests only with a service token of one of the `allowed` services:
 * no or invalid token (user tokens included) → 401, a valid token of another service → 403.
 */
export function installServiceAuth(app: FastifyInstance, verifier: ServiceTokenVerifier, allowed: string[]): void {
  app.decorateRequest('caller', null);
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith(INTERNAL_PREFIX)) return;
    const token = bearerToken(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Missing service token');
    let caller: ServiceCaller;
    try {
      caller = await verifier.verify(token);
    } catch (error) {
      request.log.debug({ err: error }, 'service token rejected');
      throw new HttpError(401, 'unauthorized', 'Invalid or expired service token');
    }
    if (!allowed.includes(caller.service)) throw new HttpError(403, 'forbidden', `${caller.service} may not call this service`);
    request.caller = caller;
  });
}

export interface ServiceTokenProviderOptions {
  /** Token endpoint (default: env TOKEN_URL, else derived from env JWKS_URL: …/openid-connect/token). */
  tokenUrl?: string;
  /** Share of the token lifetime after which a new token is fetched (default 0.8). */
  refreshAt?: number;
  /** Replaces fetch – for tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ServiceTokenProvider {
  /** A valid service token: cached, renewed at 80 % of its lifetime; concurrent callers share one request. */
  token(): Promise<string>;
}

function defaultTokenUrl(): string {
  return env('TOKEN_URL', env('JWKS_URL').replace(/\/certs$/, '/token'));
}

/** Fetches service tokens for the service account `name` (client-credentials grant). */
export function serviceTokenProvider(name: string, secret: string, options: ServiceTokenProviderOptions = {}): ServiceTokenProvider {
  const { refreshAt = 0.8, fetch: fetchImpl = fetch, now = Date.now } = options;
  const tokenUrl = options.tokenUrl ?? defaultTokenUrl();
  let cached: { token: string; renewAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const request = async (): Promise<string> => {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: name, client_secret: secret }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`service token for ${name} refused: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new Error('token endpoint answered without a token');
    cached = { token: body.access_token, renewAt: now() + body.expires_in * 1000 * refreshAt };
    return body.access_token;
  };

  return {
    async token() {
      if (cached && now() < cached.renewAt) return cached.token;
      pending ??= request().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
