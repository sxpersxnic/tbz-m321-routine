import { PermanentError, TransientError } from '@routine/service-kit';

export interface ActionEnvironment {
  actionId: string;
  externalApiUrl: string;
  /** Hostnames http.request may call ('*' = any) – prevents SSRF against internal services. */
  allowedHosts: string[];
  timeoutMs: number;
}

export type Output = Record<string, unknown>;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function call(url: URL, init: RequestInit, environment: ActionEnvironment): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      // The actionId doubles as idempotency key for the external system.
      headers: { 'idempotency-key': environment.actionId, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(environment.timeoutMs),
    });
  } catch (error) {
    throw new TransientError(`request to ${url.host} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 5xx / 429 may heal → retry. Other 4xx will never succeed → fail permanently. */
function assertSuccess(response: Response, what: string) {
  if (response.ok) return;
  const message = `${what} answered ${response.status} ${response.statusText}`;
  if (response.status >= 500 || response.status === 429 || response.status === 408) throw new TransientError(message);
  throw new PermanentError(message);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to text
    }
  }
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

async function getWeather(params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  const city = params.city;
  if (typeof city !== 'string' || city.trim() === '') throw new PermanentError('param "city" is required');
  const url = new URL('/weather', environment.externalApiUrl);
  url.searchParams.set('city', city);
  const response = await call(url, { method: 'GET' }, environment);
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
    throw new PermanentError('param "url" is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PermanentError('only http(s) URLs are allowed');
  if (!environment.allowedHosts.includes('*') && !environment.allowedHosts.includes(url.hostname)) {
    throw new PermanentError(`host "${url.hostname}" is not on the allow-list`);
  }
  const method = String(params.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) throw new PermanentError(`unsupported method ${method}`);

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
  if (typeof title !== 'string' || title.trim() === '') throw new PermanentError('param "title" is required');
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

export async function executeAction(type: string, params: Record<string, unknown>, environment: ActionEnvironment): Promise<Output> {
  switch (type) {
    case 'weather.get':
      return getWeather(params, environment);
    case 'http.request':
      return httpRequest(params, environment);
    case 'summary.generate':
      return generateSummary(params);
    default:
      throw new PermanentError(`integration-worker cannot handle action type ${type}`);
  }
}
