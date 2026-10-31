import { HttpException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';

import { AppError, type ErrorBody, type ErrorCode } from './errors';

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  415: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
  504: 'TIMEOUT',
};

const MESSAGE_BY_CODE: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'The request is not valid',
  UNAUTHORIZED: 'A valid API key is required',
  NOT_FOUND: 'Not found',
  FILE_TOO_LARGE: 'The request body is too large',
  RATE_LIMITED: 'Too many requests',
  UNAVAILABLE: 'The service is temporarily unavailable',
  TIMEOUT: 'The request timed out',
};

function body(code: ErrorCode, message: string, details?: Record<string, unknown>): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function zodDetails(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

/** Errors that Fastify raises itself (malformed JSON, body limits) carry a statusCode. */
function frameworkStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null || !('statusCode' in exception)) {
    return undefined;
  }
  const status = exception.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Turns anything thrown while handling a request into the uniform `{ error: { code, message,
 * details? } }` shape (SPEC §4). Unknown errors become a bare 500 so internals never leak.
 */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof AppError) {
    return { status: exception.status, body: exception.toBody(), headers: exception.headers };
  }
  if (exception instanceof ZodValidationException) {
    const zodError = exception.getZodError();
    const details = zodError instanceof ZodError ? zodDetails(zodError) : undefined;
    return {
      status: 400,
      body: body('VALIDATION_FAILED', 'The request is not valid', details),
      headers: {},
    };
  }
  const status =
    exception instanceof HttpException ? exception.getStatus() : frameworkStatus(exception);
  if (status !== undefined && status < 500) {
    const code = CODE_BY_STATUS[status] ?? 'VALIDATION_FAILED';
    return { status, body: body(code, MESSAGE_BY_CODE[code] ?? 'Request failed'), headers: {} };
  }
  return { status: 500, body: body('INTERNAL', 'Internal error'), headers: {} };
}
