import { Controller, Get, Header, Inject, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../auth/request-auth';
import { METRICS_REGISTRY } from '../common/tokens';
import { createMetrics, type Metrics } from './metrics';

/** Prometheus scrape endpoint; nginx allows it only from the owner's network (DEPLOY.md §4.4). */
@ApiExcludeController()
@Public()
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly metrics: Metrics) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS_REGISTRY, useFactory: createMetrics }],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
