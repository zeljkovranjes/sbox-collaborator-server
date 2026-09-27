export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'rate_limited'
  | 'invalid_server_key'
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  invalid_server_key: 401,
  authorization_pending: 428,
  slow_down: 429,
  access_denied: 403,
  expired_token: 410,
  unavailable: 503,
  internal: 500,
};

/** An error that is safe to show to the caller. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const invalid = (message: string, details?: Record<string, unknown>) => new AppError('invalid_input', message, details);
export const forbidden = (message: string) => new AppError('forbidden', message);
export const conflict = (message: string, details?: Record<string, unknown>) => new AppError('conflict', message, details);
