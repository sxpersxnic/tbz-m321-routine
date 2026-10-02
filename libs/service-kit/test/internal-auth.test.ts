import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pino from 'pino';
import { JWT_AUDIENCE } from '../src/auth.ts';
import { createHttpServer } from '../src/http.ts';
import { createServiceTokenVerifier, INTERNAL_AUDIENCE, installServiceAuth, serviceTokenProvider } from '../src/internal-auth.ts';

const ISSUER = 'http://localhost:8080/auth/realms/routine';
const JWKS_URL = 'http://keycloak:8080/auth/realms/routine/protocol/openid-connect/certs';

async function internalApp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const app = createHttpServer({ service: 'connector-service', logger: pino({ level: 'silent' }) });
  installServiceAuth(app, createServiceTokenVerifier(JWKS_URL, { issuer: ISSUER, fetch }), ['integration-worker']);
  app.get('/internal/v1/resolve', async (request) => ({ caller: request.caller?.service }));
  app.get('/api/v1/connections', async () => ({ ok: true }));

  const sign = (claims: { azp?: string; aud: string }) =>
    new SignJWT({ azp: claims.azp })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('5c1f0e1e-0000-4000-8000-000000000001') // Keycloak: the service-account user's id
      .setIssuer(ISSUER)
      .setAudience(claims.aud)
      .setExpirationTime('15m')
      .sign(privateKey);
  const call = async (url: string, token?: string) => {
    const response = await app.inject({ url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  return { app, sign, call };
}

describe('internal auth', () => {
  it('accepts a service token of an allowed service and names the caller', async () => {
    const { app, sign, call } = await internalApp();
    const response = await call('/internal/v1/resolve', await sign({ azp: 'integration-worker', aud: INTERNAL_AUDIENCE }));
    assert.equal(response.status, 200);
    assert.equal(response.body.caller, 'integration-worker');
    await app.close();
  });

  it('rejects user tokens, missing tokens and tokens without azp with 401', async () => {
    const { app, sign, call } = await internalApp();
    assert.equal((await call('/internal/v1/resolve', await sign({ azp: 'routine-web', aud: JWT_AUDIENCE }))).status, 401);
    assert.equal((await call('/internal/v1/resolve')).status, 401);
    assert.equal((await call('/internal/v1/resolve', await sign({ aud: INTERNAL_AUDIENCE }))).status, 401);
    await app.close();
  });

  it('rejects a valid service token of a service not on the allow-list with 403', async () => {
    const { app, sign, call } = await internalApp();
    assert.equal((await call('/internal/v1/resolve', await sign({ azp: 'budget-service', aud: INTERNAL_AUDIENCE }))).status, 403);
    await app.close();
  });

  it('leaves routes outside /internal alone', async () => {
    const { app, call } = await internalApp();
    assert.equal((await call('/api/v1/connections')).status, 200);
    await app.close();
  });
});

describe('serviceTokenProvider', () => {
  /** A fake token endpoint that hands out numbered tokens valid for `expiresIn` seconds. */
  function endpoint(expiresIn = 900) {
    const state = { calls: 0, bodies: [] as string[], status: 200 };
    const fetch = (async (_url: string, init: RequestInit) => {
      state.calls++;
      state.bodies.push(String(init.body));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ access_token: `token-${state.calls}`, expires_in: expiresIn }), { status: state.status });
    }) as typeof globalThis.fetch;
    return { state, fetch };
  }

  it('asks for a client-credentials token as the named service account', async () => {
    const { state, fetch } = endpoint();
    const provider = serviceTokenProvider('integration-worker', 's3cret', { tokenUrl: 'http://keycloak/token', fetch });
    assert.equal(await provider.token(), 'token-1');
    const form = new URLSearchParams(state.bodies[0]);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_id'), 'integration-worker');
    assert.equal(form.get('client_secret'), 's3cret');
  });

  it('caches the token and renews it at 80 % of its lifetime', async () => {
    let clock = 0;
    const { state, fetch } = endpoint(100);
    const provider = serviceTokenProvider('integration-worker', 's', { tokenUrl: 'http://keycloak/token', fetch, now: () => clock });
    assert.equal(await provider.token(), 'token-1');
    clock = 79_999;
    assert.equal(await provider.token(), 'token-1');
    clock = 80_000;
    assert.equal(await provider.token(), 'token-2');
    assert.equal(state.calls, 2);
  });

  it('shares one request between concurrent callers', async () => {
    const { state, fetch } = endpoint();
    const provider = serviceTokenProvider('integration-worker', 's', { tokenUrl: 'http://keycloak/token', fetch });
    const tokens = await Promise.all([provider.token(), provider.token(), provider.token()]);
    assert.deepEqual(tokens, ['token-1', 'token-1', 'token-1']);
    assert.equal(state.calls, 1);
  });

  it('fails when the token endpoint refuses, and tries again on the next call', async () => {
    const { state, fetch } = endpoint();
    const provider = serviceTokenProvider('integration-worker', 'wrong', { tokenUrl: 'http://keycloak/token', fetch });
    state.status = 401;
    await assert.rejects(provider.token(), /refused: HTTP 401/);
    state.status = 200;
    assert.equal(await provider.token(), 'token-2');
  });
});
