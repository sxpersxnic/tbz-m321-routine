import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwksCache,
  jwtVerify,
  type ExportedJWKSCache,
  type FetchImplementation,
  type JWKSCacheInput,
  type JWTVerifyGetKey,
} from 'jose';
import { HttpError } from './errors.ts';

export const JWT_ISSUER = 'routine-identity';
export const JWT_AUDIENCE = 'routine-api';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export interface TokenVerifierOptions {
  /** Age after which fetched keys are refreshed from the identity service (default 10 min). */
  cacheMaxAgeMs?: number;
  /** Pause between refresh attempts while the identity service is unreachable (default 5 s). */
  retryAfterMs?: number;
  /** Replaces the HTTP fetch of the key set – for tests. */
  fetch?: FetchImplementation;
}

/**
 * Verifies RS256 access tokens against the identity service's public JWKS.
 *
 * Keys are fetched lazily and refreshed every `cacheMaxAgeMs`. If a refresh fails because the
 * identity service is unreachable, the last successfully fetched key set keeps verifying tokens –
 * otherwise an identity outage longer than the cache age would reject every request on every
 * service (single point of failure). A key missing from a successfully fetched set is still rejected.
 */
export function createTokenVerifier(jwksUrl: string, options: TokenVerifierOptions = {}): TokenVerifier {
  const { cacheMaxAgeMs = 10 * 60_000, retryAfterMs = 5_000 } = options;
  const cache: Partial<ExportedJWKSCache> = {}; // jose writes every successfully fetched key set here
  const remote = createRemoteJWKSet(new URL(jwksUrl), {
    cooldownDuration: 5_000,
    cacheMaxAge: cacheMaxAgeMs,
    timeoutDuration: 2_000,
    [jwksCache]: cache as JWKSCacheInput,
    ...(options.fetch && { [customFetch]: options.fetch }),
  });

  let lastKnownGood: { fetchedAt: number; keys: JWTVerifyGetKey } | undefined;
  let unreachableUntil = 0;
  const fallbackKeys = (): JWTVerifyGetKey | undefined => {
    if (!cache.jwks || !cache.uat) return undefined;
    if (lastKnownGood?.fetchedAt !== cache.uat) lastKnownGood = { fetchedAt: cache.uat, keys: createLocalJWKSet(cache.jwks) };
    return lastKnownGood.keys;
  };

  const keys: JWTVerifyGetKey = async (header, token) => {
    const fallback = fallbackKeys();
    if (fallback && Date.now() < unreachableUntil) return fallback(header, token);
    try {
      return await remote(header, token);
    } catch (error) {
      // the identity service answered, the key just is not in the set → reject
      if (error instanceof errors.JWKSNoMatchingKey || !fallback) throw error;
      unreachableUntil = Date.now() + retryAfterMs;
      return fallback(header, token);
    }
  };

  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
      if (!payload.sub) throw new Error('token has no subject');
      return {
        id: payload.sub,
        email: String(payload.email ?? ''),
        name: typeof payload.name === 'string' ? payload.name : undefined,
      };
    },
  };
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
}

/**
 * Registers `request.user` and a hook that rejects unauthenticated requests on the given prefixes.
 * `publicPrefixes` carves exceptions out of them – routes that authenticate by other means (webhook tokens).
 */
export function installAuth(app: FastifyInstance, verifier: TokenVerifier, protectedPrefixes: string[], publicPrefixes: string[] = []): void {
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (!protectedPrefixes.some((prefix) => path.startsWith(prefix))) return;
    if (publicPrefixes.some((prefix) => path.startsWith(prefix))) return;
    const token = bearerToken(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Missing bearer token');
    try {
      request.user = await verifier.verify(token);
    } catch (error) {
      request.log.debug({ err: error }, 'token rejected');
      throw new HttpError(401, 'unauthorized', 'Invalid or expired token');
    }
  });
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new HttpError(401, 'unauthorized', 'Authentication required');
  return request.user;
}
