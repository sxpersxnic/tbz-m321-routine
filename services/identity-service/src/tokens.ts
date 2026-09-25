import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';
import { JWT_AUDIENCE, JWT_ISSUER, type Pool } from '@routine/service-kit';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * Loads the signing key or creates one on first start. All replicas converge
 * on the oldest key, so concurrent first starts are harmless.
 */
export async function loadSigningKey(pool: Pool): Promise<SigningKey> {
  const existing = await pool.query('SELECT 1 FROM signing_keys LIMIT 1');
  if (existing.rowCount === 0) {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const kid = randomUUID();
    await pool.query(
      'INSERT INTO signing_keys (kid, private_jwk, public_jwk) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [kid, JSON.stringify(await exportJWK(privateKey)), JSON.stringify({ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' })],
    );
  }
  const { rows } = await pool.query<{ kid: string; private_jwk: JWK; public_jwk: JWK }>(
    'SELECT kid, private_jwk, public_jwk FROM signing_keys ORDER BY created_at, kid LIMIT 1',
  );
  const row = rows[0];
  return { kid: row.kid, privateKey: (await importJWK(row.private_jwk, 'RS256')) as CryptoKey, publicJwk: row.public_jwk };
}

export async function issueAccessToken(
  key: SigningKey,
  user: { id: string; email: string; displayName: string },
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ email: user.email, name: user.displayName })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setSubject(user.id)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}
