import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';
import type { FastifyInstance } from 'fastify';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration by route template',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  return { registry, httpDuration };
}

/** Records every response under its route template, so ids never explode label cardinality. */
export function observeHttpRequests(fastify: FastifyInstance, metrics: Metrics): void {
  fastify.addHook('onResponse', (request, reply, done) => {
    metrics.httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });
}
