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
import { env } from './config.ts';
import { HttpError } from './errors.ts';

/** Audience every access token for the API must carry (Keycloak: audience mapper on the clients). */
export const JWT_AUDIENCE = 'routine-api';

/** `user` for everyone signed in; `admin` for the system endpoints (DLQ, chaos, registry). */
export type Role = 'user' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  roles: Role[];
}

/**
 * Roles of a token: every user is `user`, and `admin` when the identity provider says so – in the flat
 * `roles` claim (protocol mapper on the Keycloak clients) or Keycloak's own `realm_access.roles`.
 */
export function rolesOf(payload: Record<string, unknown>): Role[] {
  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const claimed = Array.isArray(payload.roles) ? payload.roles : Array.isArray(realmAccess?.roles) ? realmAccess.roles : [];
  return claimed.includes('admin') ? ['user', 'admin'] : ['user'];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

export interface KeySourceOptions {
  /** Age after which fetched keys are refreshed from the identity service (default 10 min). */
  cacheMaxAgeMs?: number;
  /** Pause between refresh attempts while the identity service is unreachable (default 5 s). */
  retryAfterMs?: number;
  /** Replaces the HTTP fetch of the key set – for tests. */
  fetch?: FetchImplementation;
}

export interface TokenVerifierOptions extends KeySourceOptions {
  /** Expected `iss` – the realm URL of the identity provider (default: env JWT_ISSUER, required). */
  issuer?: string;
  /** Expected `aud` (default: env JWT_AUDIENCE or `routine-api`). */
  audience?: string;
}

/**
 * The identity provider's public signing keys (JWKS), for `jwtVerify`.
 *
 * Keys are fetched lazily and refreshed every `cacheMaxAgeMs`. If a refresh fails because the
 * identity service is unreachable, the last successfully fetched key set keeps verifying tokens –
 * otherwise an identity outage longer than the cache age would reject every request on every
 * service (single point of failure). A key missing from a successfully fetched set is still rejected.
 */
export function createKeySource(jwksUrl: string, options: KeySourceOptions = {}): JWTVerifyGetKey {
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

  return async (header, token) => {
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
}

/** Verifies RS256 user access tokens of the identity provider (Keycloak), see `createKeySource`. */
export function createTokenVerifier(jwksUrl: string, options: TokenVerifierOptions = {}): TokenVerifier {
  const issuer = options.issuer ?? env('JWT_ISSUER');
  const audience = options.audience ?? env('JWT_AUDIENCE', JWT_AUDIENCE);
  const keys = createKeySource(jwksUrl, options);

  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keys, { issuer, audience });
      if (!payload.sub) throw new Error('token has no subject');
      return {
        id: payload.sub,
        email: String(payload.email ?? ''),
        name: typeof payload.name === 'string' ? payload.name : undefined,
        roles: rolesOf(payload),
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

export function requireAdmin(request: FastifyRequest): AuthUser {
  const user = requireUser(request);
  if (!user.roles.includes('admin')) throw new HttpError(403, 'forbidden', 'Admin role required');
  return user;
}

/**
 * Requires the admin role on every route under `prefixes`, except the paths in `except`. Register it
 * after `installAuth`, whose hook sets `request.user` first.
 */
export function installAdminOnly(app: FastifyInstance, prefixes: string[], except: string[] = []): void {
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (!prefixes.some((prefix) => path.startsWith(prefix)) || except.includes(path)) return;
    requireAdmin(request);
  });
}
