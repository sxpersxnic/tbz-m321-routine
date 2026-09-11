import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  conflict,
  createHttpServer,
  createLogger,
  createPool,
  createTokenVerifier,
  env,
  envInt,
  HttpError,
  installAuth,
  notFound,
  onShutdown,
  requireUser,
  runMigrations,
  waitForDatabase,
} from '@routine/service-kit';
import { hashPassword, verifyPassword } from './passwords.ts';
import { issueAccessToken, loadSigningKey } from './tokens.ts';

const SERVICE = 'identity-service';
const logger = createLogger(SERVICE);
const port = envInt('PORT', 3000);
const tokenTtlSeconds = envInt('TOKEN_TTL_SECONDS', 8 * 3600);

const pool = createPool(env('DATABASE_URL'));
await waitForDatabase(pool, logger);
await runMigrations(pool, join(import.meta.dirname, '..', 'migrations'), logger);
const signingKey = await loadSigningKey(pool);

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

const userDto = (row: UserRow) => ({ id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at });

async function createUser(email: string, password: string, displayName: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [randomUUID(), email.toLowerCase(), displayName, await hashPassword(password)],
  );
  return rows[0] ?? null;
}

// Optional demo account, created idempotently on start.
const demoEmail = process.env.DEMO_USER_EMAIL;
if (demoEmail && process.env.DEMO_USER_PASSWORD) {
  if (await createUser(demoEmail, process.env.DEMO_USER_PASSWORD, 'Demo User')) logger.info({ email: demoEmail }, 'demo user created');
}

const app = createHttpServer({
  service: SERVICE,
  logger,
  readiness: { database: async () => void (await pool.query('SELECT 1')) },
});
// The identity service verifies its own tokens through the same public JWKS as everyone else.
installAuth(app, createTokenVerifier(`http://127.0.0.1:${port}/.well-known/jwks.json`), ['/api/v1/auth/me']);

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', maxLength: 200 },
    password: { type: 'string', minLength: 8, maxLength: 200 },
    displayName: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

type Credentials = { email: string; password: string; displayName?: string };

app.get('/.well-known/jwks.json', async (_request, reply) => {
  reply.header('cache-control', 'public, max-age=300');
  return { keys: [signingKey.publicJwk] };
});

app.post<{ Body: Credentials }>('/api/v1/auth/register', { schema: { body: credentialsSchema } }, async (request, reply) => {
  const { email, password, displayName } = request.body;
  const user = await createUser(email, password, displayName ?? email.split('@')[0]);
  if (!user) throw conflict('A user with this email already exists');
  request.log.info({ userId: user.id }, 'user registered');
  return reply.status(201).send(userDto(user));
});

app.post<{ Body: Credentials }>('/api/v1/auth/login', { schema: { body: credentialsSchema } }, async (request) => {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [request.body.email.toLowerCase()]);
  const user = rows[0];
  // Same response for unknown user and wrong password – no user enumeration.
  if (!user || !(await verifyPassword(request.body.password, user.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Email or password is wrong');
  }
  const accessToken = await issueAccessToken(signingKey, { id: user.id, email: user.email, displayName: user.display_name }, tokenTtlSeconds);
  request.log.info({ userId: user.id }, 'user logged in');
  return { accessToken, tokenType: 'Bearer', expiresIn: tokenTtlSeconds, user: userDto(user) };
});

app.get('/api/v1/auth/me', async (request) => {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [requireUser(request).id]);
  if (!rows[0]) throw notFound('User');
  return userDto(rows[0]);
});

await app.listen({ host: '0.0.0.0', port });
logger.info({ kid: signingKey.kid }, 'identity-service ready');

onShutdown(logger, () => app.close(), () => pool.end());
