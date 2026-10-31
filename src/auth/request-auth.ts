import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../common/errors';
import { type AuthContext, USER_ID_PATTERN } from './api-keys';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const IS_PUBLIC = 'media:is-public';

/** Marks a route or controller as reachable without an API key. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Injects the authenticated caller into a handler parameter. */
export const Auth = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = context.switchToHttp().getRequest<FastifyRequest>().auth;
  if (!auth) throw new Error('@Auth() used on a public route');
  return auth;
});

/** Like @Auth(), but for routes that act on behalf of an end user (SPEC §3). */
export function requireUserId(auth: AuthContext): string {
  if (auth.userId === undefined) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This request needs an end-user id: send an X-User-Id header or use a key with a default user id',
    );
  }
  return auth.userId;
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

/** The X-User-Id header wins over the key's default user id. */
export function resolveUserId(
  header: string | string[] | undefined,
  defaultUserId: string | null,
): string | undefined {
  if (header === undefined) return defaultUserId ?? undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !USER_ID_PATTERN.test(value)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'X-User-Id must be 1-128 characters: letters, digits and . _ : @ -',
    );
  }
  return value;
}
