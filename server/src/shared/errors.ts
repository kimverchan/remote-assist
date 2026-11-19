import { ERROR_CODES, type ErrorCode } from './protocol';

/** 所有可预期业务错误都必须走 AppError，客户端只看到规范化结构 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_CODES[code].http;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown) {
    super('INVALID_INPUT', undefined, details);
    this.name = 'ValidationError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function normalizeErrorBody(err: unknown, requestId?: string) {
  if (isAppError(err)) {
    return {
      status: err.httpStatus,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      },
    };
  }
  return {
    status: ERROR_CODES.INTERNAL.http,
    body: { error: { code: 'INTERNAL', message: ERROR_CODES.INTERNAL.message, requestId } },
  };
}
