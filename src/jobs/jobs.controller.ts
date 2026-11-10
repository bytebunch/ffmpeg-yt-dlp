import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  distinctUntilChanged,
  from,
  interval,
  map,
  type Observable,
  startWith,
  switchMap,
  takeWhile,
} from 'rxjs';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { OutputRemoval, type Removal } from '../outputs/output-removal';
import { JobsService, type JobView, TERMINAL_STATUSES } from './jobs.service';
import { downloadJobSchema, listJobsQuerySchema } from './schemas';

class ListJobsQueryDto extends createZodDto(listJobsQuerySchema) {}
class ItemsQueryDto extends createZodDto(
  z.strictObject({
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped']).optional(),
    cursor: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
) {}

const EVENT_INTERVAL_MS = 1000;

/** SPEC §4 "Jobs". */
@ApiTags('jobs')
@ApiBearerAuth()
@Controller('v1/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly removal: OutputRemoval,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiBody({ schema: z.toJSONSchema(downloadJobSchema, { io: 'input' }) as object })
  create(
    @Auth() auth: AuthContext,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JobView> {
    return this.jobs.create(auth, body, idempotencyKey);
  }

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: ListJobsQueryDto) {
    return this.jobs.list(auth, query);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id') id: string): Promise<JobView> {
    return this.jobs.get(auth, id);
  }

  @Get(':id/items')
  items(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: ItemsQueryDto) {
    return this.jobs.items(auth, id, query);
  }

  @Get(':id/outputs')
  outputs(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.jobs.outputs(auth, id);
  }

  @Get(':id/log')
  log(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.jobs.log(auth, id);
  }

  /** Server-sent events: a job snapshot whenever it changes, ending with the final state. */
  @Sse(':id/events')
  async events(
    @Auth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<Observable<{ data: JobView }>> {
    await this.jobs.find(auth, id);
    return interval(EVENT_INTERVAL_MS).pipe(
      startWith(0),
      switchMap(() => from(this.jobs.get(auth, id))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      takeWhile((job) => !TERMINAL_STATUSES.includes(job.status), true),
      map((job) => ({ data: job })),
    );
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(@Auth() auth: AuthContext, @Param('id') id: string): Promise<JobView> {
    return this.jobs.retry(auth, id);
  }

  /** Deletes every file of a finished job (of a playlist or batch: every item's) now. */
  @Delete(':id/outputs')
  @HttpCode(200)
  deleteOutputs(@Auth() auth: AuthContext, @Param('id') id: string): Promise<Removal> {
    return this.removal.deleteJobOutputs(auth, id);
  }

  @Delete(':id')
  @HttpCode(202)
  cancel(@Auth() auth: AuthContext, @Param('id') id: string): Promise<JobView> {
    return this.jobs.cancel(auth, id);
  }
}
