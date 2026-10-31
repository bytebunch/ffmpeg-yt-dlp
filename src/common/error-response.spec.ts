import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { toErrorResponse } from './error-response';
import { AppError, ERROR_CODES, statusFor } from './errors';

describe('toErrorResponse', () => {
  it('passes AppErrors through with their status, details and headers', () => {
    const error = new AppError('RATE_LIMITED', 'Slow down', { limit: 120 }, { 'retry-after': '7' });
    expect(toErrorResponse(error)).toEqual({
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'Slow down', details: { limit: 120 } } },
      headers: { 'retry-after': '7' },
    });
  });

  it('omits details when an AppError has none', () => {
    expect(toErrorResponse(new AppError('MEDIA_PRIVATE', 'Private')).body).toEqual({
      error: { code: 'MEDIA_PRIVATE', message: 'Private' },
    });
  });

  it('lists every Zod issue with its path', () => {
    const result = z
      .object({ url: z.url(), max: z.number().max(5) })
      .safeParse({ url: 'x', max: 9 });
    if (result.success) throw new Error('expected a validation failure');
    const response = toErrorResponse(new ZodValidationException(result.error));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details?.issues).toEqual([
      expect.objectContaining({ path: 'url' }),
      expect.objectContaining({ path: 'max' }),
    ]);
  });

  it('maps Nest HTTP exceptions to stable codes', () => {
    expect(toErrorResponse(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
    expect(toErrorResponse(new BadRequestException()).body.error.code).toBe('VALIDATION_FAILED');
    expect(toErrorResponse(new PayloadTooLargeException()).status).toBe(413);
  });

  it('maps Fastify client errors such as malformed JSON', () => {
    const fastifyError = Object.assign(new SyntaxError('Unexpected token'), { statusCode: 400 });
    expect(toErrorResponse(fastifyError)).toMatchObject({
      status: 400,
      body: { error: { code: 'VALIDATION_FAILED' } },
    });
  });

  it('hides the details of unexpected errors', () => {
    const response = toErrorResponse(new Error('connection string postgres://user:pw@db'));
    expect(response).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Internal error' } },
      headers: {},
    });
  });

  it('treats a 5xx statusCode on a plain error as internal', () => {
    expect(toErrorResponse(Object.assign(new Error('x'), { statusCode: 502 })).status).toBe(500);
  });
});

describe('error codes', () => {
  it('maps every code to an HTTP error status', () => {
    for (const code of ERROR_CODES) {
      expect(statusFor(code)).toBeGreaterThanOrEqual(400);
      expect(statusFor(code)).toBeLessThan(600);
    }
  });
});
