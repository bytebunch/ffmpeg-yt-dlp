import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { abortOnDisconnect } from '../common/abort';
import { DiscoveryService } from './discovery.service';
import {
  commentsRequestSchema,
  infoRequestSchema,
  searchQuerySchema,
  transcriptRequestSchema,
} from './schemas';

class InfoRequestDto extends createZodDto(infoRequestSchema) {}
class SearchQueryDto extends createZodDto(searchQuerySchema) {}
class TranscriptRequestDto extends createZodDto(transcriptRequestSchema) {}
class CommentsRequestDto extends createZodDto(commentsRequestSchema) {}

/** SPEC §4 "Discovery": synchronous yt-dlp calls. */
@ApiTags('discovery')
@ApiBearerAuth()
@Controller('v1')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('info')
  @HttpCode(200)
  info(
    @Auth() auth: AuthContext,
    @Body() body: InfoRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.discovery.info(auth, body, abortOnDisconnect(reply));
  }

  @Get('search')
  search(
    @Auth() auth: AuthContext,
    @Query() query: SearchQueryDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.discovery.search(auth, query, abortOnDisconnect(reply));
  }

  @Post('transcripts')
  @HttpCode(200)
  transcripts(
    @Auth() auth: AuthContext,
    @Body() body: TranscriptRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.discovery.transcript(auth, body, abortOnDisconnect(reply));
  }

  @Post('comments')
  @HttpCode(200)
  comments(
    @Auth() auth: AuthContext,
    @Body() body: CommentsRequestDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.discovery.comments(auth, body, abortOnDisconnect(reply));
  }
}
