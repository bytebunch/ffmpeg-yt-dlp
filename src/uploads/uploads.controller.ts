import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { UploadsService } from './uploads.service';

class CreateUploadDto extends createZodDto(
  z.strictObject({
    filename: z.string().min(1).max(1000),
    size: z.number().int().min(1),
    mime: z
      .string()
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .max(100)
      .optional(),
  }),
) {}

/** SPEC §4 Inputs: create a resumable upload, read its state, discard it. */
@ApiTags('uploads')
@ApiBearerAuth()
@Controller('v1/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  create(@Auth() auth: AuthContext, @Body() body: CreateUploadDto) {
    return this.uploads.create(auth, body);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.uploads.get(auth, id);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.uploads.remove(auth, id);
  }
}
