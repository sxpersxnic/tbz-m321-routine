import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { createTokenVerifier, JWT_AUDIENCE, JWT_ISSUER } from '../src/auth.ts';

async function signingKey(kid: string): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

const token = (key: { privateKey: CryptoKey; jwk: JWK }) =>
  new SignJWT({ email: 'demo@routine.local' })
    .setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid })
    .setSubject('user-1')
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime('5m')
    .sign(key.privateKey);

/** A fake identity service: serves `keys` while `up`, refuses connections otherwise. */
function identity(keys: JWK[]) {
  const state = { up: true, keys, fetches: 0 };
  const fetch = async () => {
    state.fetches++;
    if (!state.up) throw new TypeError('fetch failed: connect ECONNREFUSED identity-service:3000');
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  };
  return { state, fetch };
}

describe('token verifier', () => {
  it('keeps verifying with the last fetched keys while the identity service is down', async () => {
    const key = await signingKey('k1');
    const { state, fetch } = identity([key.jwk]);
    // cache age 0: every verification wants fresh keys, like after a long identity outage
    const verifier = createTokenVerifier('http://identity-service:3000/.well-known/jwks.json', { cacheMaxAgeMs: 0, retryAfterMs: 60_000, fetch });
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
    const verifier = createTokenVerifier('http://identity-service:3000/.well-known/jwks.json', { cacheMaxAgeMs: 0, retryAfterMs: 0, fetch });
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
    const verifier = createTokenVerifier('http://identity-service:3000/.well-known/jwks.json', { fetch });
    await assert.rejects(verifier.verify(await token(key)));
  });

  it('rejects a key the reachable identity service no longer publishes', async () => {
    const retired = await signingKey('old');
    const current = await signingKey('new');
    const { state, fetch } = identity([retired.jwk]);
    const verifier = createTokenVerifier('http://identity-service:3000/.well-known/jwks.json', { cacheMaxAgeMs: 0, fetch });
    await verifier.verify(await token(retired));

    state.keys = [current.jwk];
    await assert.rejects(verifier.verify(await token(retired)), { code: 'ERR_JWKS_NO_MATCHING_KEY' });
    assert.equal((await verifier.verify(await token(current))).id, 'user-1');
  });
});
