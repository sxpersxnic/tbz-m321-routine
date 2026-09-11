/** A failure that may succeed when retried later (network, 5xx, dependency down). */
export class TransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/** A failure that will never succeed on retry (invalid input, 4xx, unsupported payload). */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** An error that maps directly to an HTTP problem response. */
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
