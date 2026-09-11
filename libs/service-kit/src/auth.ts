import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
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

/**
 * Verifies RS256 access tokens against the identity service's public JWKS.
 * Keys are fetched lazily and cached, so services stay available even if the
 * identity service is briefly down (as long as the key is cached).
 */
export function createTokenVerifier(jwksUrl: string): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 5_000, cacheMaxAge: 10 * 60_000 });
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, jwks, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
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

/** Registers `request.user` and a hook that rejects unauthenticated requests on the given prefixes. */
export function installAuth(app: FastifyInstance, verifier: TokenVerifier, protectedPrefixes: string[]): void {
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (!protectedPrefixes.some((prefix) => path.startsWith(prefix))) return;
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
