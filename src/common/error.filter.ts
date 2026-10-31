import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { toErrorResponse } from './error-response';
import { AppError } from './errors';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const { status, body, headers } = toErrorResponse(exception);
    const context = { requestId: request.id, route: request.routeOptions.url };
    if (!(exception instanceof AppError) && status >= 500) {
      this.logger.error({ err: exception, ...context }, 'Request failed');
    } else if (status >= 500) {
      // Expected outcomes such as FEATURE_DISABLED or a site being unreachable: no stack.
      this.logger.warn({ ...context, code: body.error.code }, body.error.message);
    }
    void http.getResponse<FastifyReply>().status(status).headers(headers).send(body);
  }
}
