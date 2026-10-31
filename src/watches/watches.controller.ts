import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { watchCreateSchema, watchPage, watchPatchSchema, WatchesService } from './watches.service';

class WatchCreateDto extends createZodDto(watchCreateSchema) {}
class WatchPatchDto extends createZodDto(watchPatchSchema) {}
class WatchPageDto extends createZodDto(watchPage) {}

/** Channel and playlist watches (SPEC §4, §9f). */
@ApiTags('watches')
@ApiBearerAuth()
@Controller('v1/watches')
export class WatchesController {
  constructor(private readonly watches: WatchesService) {}

  @Post()
  @HttpCode(201)
  create(@Auth() auth: AuthContext, @Body() body: WatchCreateDto) {
    return this.watches.create(auth, body);
  }

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: WatchPageDto) {
    return this.watches.list(auth, query);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.watches.get(auth, id);
  }

  @Patch(':id')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body() body: WatchPatchDto) {
    return this.watches.update(auth, id, body);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.watches.remove(auth, id);
  }

  @Get(':id/runs')
  runs(@Auth() auth: AuthContext, @Param('id') id: string, @Query() query: WatchPageDto) {
    return this.watches.runs(auth, id, query);
  }
}
