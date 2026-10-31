import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';

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
  info(@Body() body: InfoRequestDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.discovery.info(body, abortOnDisconnect(reply));
  }

  @Get('search')
  search(@Query() query: SearchQueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.discovery.search(query, abortOnDisconnect(reply));
  }

  @Post('transcripts')
  @HttpCode(200)
  transcripts(@Body() body: TranscriptRequestDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.discovery.transcript(body, abortOnDisconnect(reply));
  }

  @Post('comments')
  @HttpCode(200)
  comments(@Body() body: CommentsRequestDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.discovery.comments(body, abortOnDisconnect(reply));
  }
}
