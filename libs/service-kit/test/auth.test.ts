import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import pino from 'pino';
import { createTokenVerifier, installAdminOnly, installAuth, JWT_AUDIENCE, rolesOf } from '../src/auth.ts';
import { createHttpServer } from '../src/http.ts';

const ISSUER = 'http://localhost:8080/auth/realms/routine';
const JWKS_URL = 'http://keycloak:8080/auth/realms/routine/protocol/openid-connect/certs';

async function signingKey(kid: string): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

const token = (key: { privateKey: CryptoKey; jwk: JWK }, claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: 'demo@routine.local', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid })
    .setSubject('user-1')
    .setIssuer(ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime('5m')
    .sign(key.privateKey);

/** A fake identity provider: serves `keys` while `up`, refuses connections otherwise. */
function identity(keys: JWK[]) {
  const state = { up: true, keys, fetches: 0 };
  const fetch = async () => {
    state.fetches++;
    if (!state.up) throw new TypeError('fetch failed: connect ECONNREFUSED keycloak:8080');
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  };
  return { state, fetch };
}

describe('token verifier', () => {
  it('keeps verifying with the last fetched keys while the identity service is down', async () => {
    const key = await signingKey('k1');
    const { state, fetch } = identity([key.jwk]);
    // cache age 0: every verification wants fresh keys, like after a long identity outage
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, cacheMaxAgeMs: 0, retryAfterMs: 60_000, fetch });
    assert.equal((await verifier.verify(await token(key))).id, 'user-1');

    state.up = false;
    assert.equal((await verifier.verify(await token(key))).id, 'user-1');
    const fetchesDuringOutage = state.fetches;
    await verifier.verify(await token(key));
    assert.equal(state.fetches, fetchesDuringOutage, 'no refresh attempt before retryAfterMs – requests do not wait for the timeout');
  });

  it('refreshes again once the identity service is back', async () => {
    const key = await signingKey('k1');
    const { state, fetch } = identity([key.jwk]);
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, cacheMaxAgeMs: 0, retryAfterMs: 0, fetch });
    await verifier.verify(await token(key));
    state.up = false;
    await verifier.verify(await token(key));
    state.up = true;
    const before = state.fetches;
    await verifier.verify(await token(key));
    assert.ok(state.fetches > before);
  });

  it('rejects tokens when no key set was ever fetched', async () => {
    const key = await signingKey('k1');
    const { state, fetch } = identity([key.jwk]);
    state.up = false;
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, fetch });
    await assert.rejects(verifier.verify(await token(key)));
  });

  it('rejects a token from another issuer or for another audience', async () => {
    const key = await signingKey('k1');
    const { fetch } = identity([key.jwk]);
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, fetch });
    const signed = (issuer: string, audience: string) =>
      new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('user-1')
        .setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(key.privateKey);
    await assert.rejects(verifier.verify(await signed('http://evil.example/auth/realms/routine', JWT_AUDIENCE)));
    await assert.rejects(verifier.verify(await signed(ISSUER, 'account')));
  });

  it('rejects a key the reachable identity service no longer publishes', async () => {
    const retired = await signingKey('old');
    const current = await signingKey('new');
    const { state, fetch } = identity([retired.jwk]);
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, cacheMaxAgeMs: 0, fetch });
    await verifier.verify(await token(retired));

    state.keys = [current.jwk];
    await assert.rejects(verifier.verify(await token(retired)), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
    assert.equal((await verifier.verify(await token(current))).id, 'user-1');
  });
});

describe('roles', () => {
  it('makes every user `user`, and `admin` from the roles claim or Keycloak realm_access', () => {
    assert.deepEqual(rolesOf({}), ['user']);
    assert.deepEqual(rolesOf({ roles: ['default-roles-routine', 'offline_access'] }), ['user']);
    assert.deepEqual(rolesOf({ roles: ['admin'] }), ['user', 'admin']);
    assert.deepEqual(rolesOf({ realm_access: { roles: ['admin'] } }), ['user', 'admin']);
    assert.deepEqual(rolesOf({ roles: 'admin' }), ['user'], 'a string is not a role list');
  });

  it('puts the roles on the verified user', async () => {
    const key = await signingKey('k1');
    const verifier = createTokenVerifier(JWKS_URL, { issuer: ISSUER, fetch: identity([key.jwk]).fetch });
    assert.deepEqual((await verifier.verify(await token(key))).roles, ['user']);
    assert.deepEqual((await verifier.verify(await token(key, { roles: ['admin'] }))).roles, ['user', 'admin']);
  });

  it('keeps admin routes to admins, and the status route open to every user', async () => {
    const key = await signingKey('k1');
    const app = createHttpServer({ service: 'test', logger: pino({ level: 'silent' }) });
    installAuth(app, createTokenVerifier(JWKS_URL, { issuer: ISSUER, fetch: identity([key.jwk]).fetch }), ['/api/v1/system']);
    installAdminOnly(app, ['/api/v1/system'], ['/api/v1/system/status']);
    app.get('/api/v1/system/status', async () => ({ ok: true }));
    app.get('/api/v1/system/dlq', async () => ({ ok: true }));

    const call = async (url: string, claims?: Record<string, unknown>) =>
      (await app.inject({ url, headers: claims ? { authorization: `Bearer ${await token(key, claims)}` } : {} })).statusCode;
    assert.equal(await call('/api/v1/system/dlq'), 401);
    assert.equal(await call('/api/v1/system/dlq', {}), 403);
    assert.equal(await call('/api/v1/system/dlq?x=1', { roles: ['user'] }), 403);
    assert.equal(await call('/api/v1/system/dlq', { roles: ['admin'] }), 200);
    assert.equal(await call('/api/v1/system/status', {}), 200);
    assert.equal(await call('/api/v1/system/status?refresh=1', {}), 200);
    await app.close();
  });
});
