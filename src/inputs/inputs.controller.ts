import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { OutputRemoval, type Removal } from '../outputs/output-removal';
import { InputsService, pageSchema } from './inputs.service';
import { inputSchema } from './schemas';

class ProbeDto extends createZodDto(z.strictObject({ input: inputSchema })) {}
class PageDto extends createZodDto(pageSchema) {}

/** SPEC §4: probe any input, list the client's inbox, list and delete the user's outputs. */
@ApiTags('inputs')
@ApiBearerAuth()
@Controller('v1')
export class InputsController {
  constructor(
    private readonly inputs: InputsService,
    private readonly removal: OutputRemoval,
  ) {}

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

  /** Deletes one of the user's finished files now, before it expires. */
  @Delete('outputs/:id')
  @HttpCode(200)
  deleteOutput(@Auth() auth: AuthContext, @Param('id') id: string): Promise<Removal> {
    return this.removal.deleteOutput(auth, id);
  }
}
