import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { archiveEntry, archivePage, ArchiveService } from './archive.service';

class ArchiveImportDto extends createZodDto(
  z.strictObject({ entries: z.array(archiveEntry).min(1).max(1000) }),
) {}
class ArchiveListDto extends createZodDto(archivePage) {}

/** The user's download archive (SPEC §4 per-user settings; used by skip_downloaded). */
@ApiTags('archive')
@ApiBearerAuth()
@Controller('v1/archive')
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query() query: ArchiveListDto) {
    return this.archive.list(auth, query);
  }

  @Post()
  import(@Auth() auth: AuthContext, @Body() body: ArchiveImportDto) {
    return this.archive.import(auth, body);
  }

  /** `:entry` is "<extractor>:<media_id>", e.g. youtube:dQw4w9WgXcQ. */
  @Delete(':entry')
  remove(@Auth() auth: AuthContext, @Param('entry') entry: string) {
    return this.archive.remove(auth, entry);
  }
}
