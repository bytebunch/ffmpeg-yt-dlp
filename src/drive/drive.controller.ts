import { Controller, Delete, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth, Public } from '../auth/request-auth';
import { callbackPage } from './callback-page';
import { DriveConnections } from './drive-connections.service';
import { CALLBACK_PATH } from './google-oauth';

export const drivePage = z.strictObject({
  cursor: z
    .string()
    .regex(/^[\x21-\x7e]{1,1000}$/, 'must be next_cursor from the previous page')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
class DrivePageDto extends createZodDto(drivePage) {}

class CallbackQueryDto extends createZodDto(
  z.object({
    state: z.string().max(200).optional(),
    code: z.string().max(2000).optional(),
    error: z.string().max(200).optional(),
  }),
) {}

/** Google Drive connection (SPEC §4 "Google Drive", §11). */
@ApiTags('drive')
@ApiBearerAuth()
@Controller()
export class DriveController {
  constructor(private readonly connections: DriveConnections) {}

  /** A consent URL to hand to the user; agents pass it on as is. */
  @Post('v1/drive/connect')
  @HttpCode(200)
  connect(@Auth() auth: AuthContext) {
    return this.connections.connect(auth);
  }

  @Get('v1/drive/status')
  status(@Auth() auth: AuthContext) {
    return this.connections.status(auth);
  }

  /** Files and folders this service created: usable as `folderId` targets and as inputs. */
  @Get('v1/drive/files')
  files(@Auth() auth: AuthContext, @Query() query: DrivePageDto) {
    return this.connections.files(auth, query);
  }

  @Delete('v1/drive/connection')
  disconnect(@Auth() auth: AuthContext) {
    return this.connections.disconnect(auth);
  }

  /** Google's redirect target: public, single-use state, a self-contained page. */
  @Public()
  @ApiExcludeEndpoint()
  @Get(CALLBACK_PATH.slice(1))
  async callback(@Query() query: CallbackQueryDto, @Res() reply: FastifyReply): Promise<void> {
    const result = await this.connections.complete(query);
    await reply
      .status(result.ok ? 200 : 400)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      )
      .send(callbackPage(result));
  }
}
