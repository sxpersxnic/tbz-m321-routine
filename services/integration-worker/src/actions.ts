import { PermanentError, TransientError, type ErrorCode } from '@routine/service-kit';

export interface ActionEnvironment {
  actionId: string;
  /** `test`: answer with a preview instead of acting (only steps whose manifest says `preview`). */
  mode?: 'live' | 'test';
  externalApiUrl: string;
  /** Hostnames http.request may call ('*' = any) – prevents SSRF against internal services. */
  allowedHosts: string[];
  timeoutMs: number;
}

export type Output = Record<string, unknown>;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
/** Larger answers are cut off instead of being buffered – a routine must not exhaust the worker's memory. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT_OUTPUT = 2_000;
const INVALID_PARAMS = { code: 'INVALID_PARAMS' } as const;

interface Outgoing {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function assertAllowedTarget(url: URL, environment: ActionEnvironment) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PermanentError('only http(s) URLs are allowed', INVALID_PARAMS);
  if (!environment.allowedHosts.includes('*') && !environment.allowedHosts.includes(url.hostname)) {
    throw new PermanentError(`host "${url.hostname}" is not on the allow-list`, { code: 'FORBIDDEN_HOST' });
  }
}

/**
 * fetch with manually followed redirects: fetch would follow them on its own, so an
 * allowed host could bounce the worker to an internal one (SSRF). Every hop is
 * therefore checked against the allow-list like the original URL.
 */
async function call(url: URL, outgoing: Outgoing, environment: ActionEnvironment): Promise<Response> {
  const signal = AbortSignal.timeout(environment.timeoutMs);
  // The actionId doubles as idempotency key for the external system – set last so params cannot override it.
  let request: Outgoing = { ...outgoing, headers: { ...outgoing.headers, 'idempotency-key': environment.actionId } };
  let target = url;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(target, { ...request, redirect: 'manual', signal });
    } catch (error) {
      // AbortSignal.timeout rejects with a DOMException named TimeoutError; anything else is the connection
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE';
      throw new TransientError(`request to ${target.host} failed: ${error instanceof Error ? error.message : String(error)}`, { code });
    }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) throw new PermanentError(`${target.host} redirected more than ${MAX_REDIRECTS} times`);

    const next = new URL(location, target);
    assertAllowedTarget(next, environment);
    // Same rules fetch applies when it follows redirects itself:
    if (next.origin !== target.origin) {
      const { authorization: _dropped, ...headers } = request.headers;
      request = { ...request, headers };
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST')) {
      request = { ...request, method: 'GET', body: undefined };
    }
    target = next;
  }
}

/** Error code for an unsuccessful HTTP status (docs/v2/05-messaging.md §6). */
export function statusErrorCode(status: number): ErrorCode {
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408) return 'TIMEOUT';
  if (status >= 500) return 'UNREACHABLE';
  return 'INVALID_PARAMS';
}

/** 5xx / 429 / 408 may heal → retry. Other 4xx will never succeed → fail permanently. */
function assertSuccess(response: Response, what: string) {
  if (response.ok) return;
  const message = `${what} answered ${response.status} ${response.statusText}`;
  const code = statusErrorCode(response.status);
  if (response.status >= 500 || response.status === 429 || response.status === 408) throw new TransientError(message, { code });
  throw new PermanentError(message, { code });
}

/** Streams the body and stops after MAX_BODY_BYTES instead of buffering whatever the server sends. */
async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { text: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'), truncated: true };
    }
  }
}

async function readBody(response: Response): Promise<unknown> {
  const { text, truncated } = await readLimited(response);
  if (!truncated && (response.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to text
    }
  }
  return text.length > MAX_TEXT_OUTPUT ? `${text.slice(0, MAX_TEXT_OUTPUT)}…` : text;
}

async function getWeather(params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  const city = params.city;
  if (typeof city !== 'string' || city.trim() === '') throw new PermanentError('param "city" is required', INVALID_PARAMS);
  const url = new URL('/weather', environment.externalApiUrl);
  url.searchParams.set('city', city);
  const response = await call(url, { method: 'GET', headers: {} }, environment);
  assertSuccess(response, 'weather service');
  const body = (await response.json()) as { city: string; temperatureC: number; condition: string };
  return {
    city: body.city,
    temperatureC: body.temperatureC,
    condition: body.condition,
    summary: `${body.city}: ${body.condition}, ${body.temperatureC} °C`,
  };
}

async function httpRequest(params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  let url: URL;
  try {
    url = new URL(String(params.url));
  } catch {
    throw new PermanentError('param "url" is not a valid URL', INVALID_PARAMS);
  }
  assertAllowedTarget(url, environment);
  const method = String(params.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new PermanentError(`unsupported method ${method}`, INVALID_PARAMS);

  const headers: Record<string, string> = {};
  if (params.headers && typeof params.headers === 'object') {
    for (const [name, value] of Object.entries(params.headers)) headers[name.toLowerCase()] = String(value);
  }
  let body: string | undefined;
  if (params.body !== undefined && method !== 'GET') {
    body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    headers['content-type'] ??= 'application/json';
  }

  const response = await call(url, { method, headers, body }, environment);
  assertSuccess(response, url.host);
  return { status: response.status, body: await readBody(response) };
}

function generateSummary(params: Record<string, unknown>): Output {
  const title = params.title;
  if (typeof title !== 'string' || title.trim() === '') throw new PermanentError('param "title" is required', INVALID_PARAMS);
  const lines: string[] = [];
  if (params.sections && typeof params.sections === 'object') {
    for (const [name, value] of Object.entries(params.sections)) {
      lines.push(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  if (Array.isArray(params.lines)) lines.push(...params.lines.map(String));
  const text = [title, ...lines.map((line) => `• ${line}`)].join('\n');
  return { title, text, lineCount: lines.length };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sends through the (mock) mail provider; the actionId as idempotency key makes a redelivery send nothing twice. */
async function sendEmail(params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  const to = (Array.isArray(params.to) ? params.to : String(params.to ?? '').split(/[,;]/))
    .map((address) => String(address).trim())
    .filter(Boolean);
  if (to.length === 0) throw new PermanentError('param "to" is required', INVALID_PARAMS);
  const invalid = to.find((address) => !EMAIL.test(address));
  if (invalid) throw new PermanentError(`"${invalid}" is not an e-mail address`, INVALID_PARAMS);
  if (to.length > 20) throw new PermanentError('at most 20 recipients', INVALID_PARAMS);
  const subject = params.subject;
  if (typeof subject !== 'string' || subject.trim() === '') throw new PermanentError('param "subject" is required', INVALID_PARAMS);
  const body = params.body === undefined ? '' : typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
  // a test run: everything checked, nothing sent (the manifest declares email.send with `preview`)
  if (environment.mode === 'test') return { preview: { to: to.join(', '), subject }, wouldDo: `Send e-mail "${subject}" to ${to.join(', ')}` };

  const url = new URL('/mail/messages', environment.externalApiUrl);
  const response = await call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, body }) }, environment);
  assertSuccess(response, 'mail provider');
  const accepted = (await response.json()) as { messageId: string; acceptedAt: string };
  return { messageId: accepted.messageId, to: to.join(', '), subject, sentAt: accepted.acceptedAt };
}

export async function executeAction(type: string, params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  switch (type) {
    case 'weather.get':
      return getWeather(params, environment);
    case 'http.request':
      return httpRequest(params, environment);
    case 'summary.generate':
      return generateSummary(params);
    case 'email.send':
      return sendEmail(params, environment);
    default:
      throw new PermanentError(`integration-worker cannot handle action type ${type}`, { code: 'NOT_AVAILABLE' });
  }
}
