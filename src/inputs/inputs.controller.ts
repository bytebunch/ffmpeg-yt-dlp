import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { InputsService, pageSchema } from './inputs.service';
import { inputSchema } from './schemas';

class ProbeDto extends createZodDto(z.strictObject({ input: inputSchema })) {}
class PageDto extends createZodDto(pageSchema) {}

/** SPEC §4: probe any input, list the client's inbox and the user's reusable outputs. */
@ApiTags('inputs')
@ApiBearerAuth()
@Controller('v1')
export class InputsController {
  constructor(private readonly inputs: InputsService) {}

  /** Synchronous up to PROBE_MAX_MB; larger URL inputs become a `probe` job (202). */
  @Post('probe')
  @HttpCode(200)
  async probe(
    @Auth() auth: AuthContext,
    @Body() body: ProbeDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.inputs.probe(auth, body.input);
    if (result.queued) void reply.status(202);
    return result.body;
  }

  @Get('inbox')
  inbox(@Auth() auth: AuthContext, @Query() query: PageDto) {
    return this.inputs.inbox(auth, query);
  }

  /** Unexpired outputs reusable as `{ type: "output", outputId }` inputs. */
  @Get('outputs')
  outputs(@Auth() auth: AuthContext, @Query() query: PageDto) {
    return this.inputs.outputs(auth, query);
  }
}
