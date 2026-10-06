/**
 * Why an action failed – `ActionFailed.error.code` and `execution_actions.error_code`
 * (docs/v2/05-messaging.md §6). Retrying is decided by the exception class, not the code.
 */
export const ERROR_CODES = [
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN_HOST',
  'TIMEOUT',
  'UNREACHABLE',
  'RATE_LIMITED',
  'INVALID_PARAMS',
  'TEMPLATE_ERROR',
  'NOT_AVAILABLE',
  'REFERENCE_GONE',
  'SUBROUTINE_FAILED',
  'AWAIT_EXPIRED',
  'QUOTA_EXCEEDED',
  'AI_REFUSED',
  'INPUT_TOO_LARGE',
  'CONFLICT',
  'CANCELLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface CodedErrorOptions extends ErrorOptions {
  /** Default `INTERNAL`. */
  code?: ErrorCode;
}

/** A failure that may succeed when retried later (network, 5xx, dependency down). */
export class TransientError extends Error {
  code: ErrorCode;

  constructor(message: string, options?: CodedErrorOptions) {
    super(message, options);
    this.name = 'TransientError';
    this.code = options?.code ?? 'INTERNAL';
  }
}

/** A failure that will never succeed on retry (invalid input, 4xx, unsupported payload). */
export class PermanentError extends Error {
  code: ErrorCode;

  constructor(message: string, options?: CodedErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
    this.code = options?.code ?? 'INTERNAL';
  }
}

/** The code to report for any caught error: its own for Transient/PermanentError, otherwise `INTERNAL`. */
export function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof TransientError || error instanceof PermanentError ? error.code : 'INTERNAL';
}

/** Reads a received code (tolerant reader): v1 sent class names, and unknown codes count as `INTERNAL`. */
export function toErrorCode(value: unknown): ErrorCode {
  if (value === 'SubRoutineFailed') return 'SUBROUTINE_FAILED';
  return ERROR_CODES.includes(value as ErrorCode) ? (value as ErrorCode) : 'INTERNAL';
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
