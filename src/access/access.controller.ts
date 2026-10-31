import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { cookiesBody, CookiesService } from './cookies.service';
import { credentialBody, CredentialsService } from './credentials.service';

class CookiesDto extends createZodDto(cookiesBody) {}
class CredentialDto extends createZodDto(credentialBody) {}

/** Per-user cookie jars (SPEC §4). Contents are write-only: lists show domains, expiry and label. */
@ApiTags('access')
@ApiBearerAuth()
@Controller('v1/cookies')
export class CookiesController {
  constructor(private readonly cookies: CookiesService) {}

  @Put()
  put(@Auth() auth: AuthContext, @Body() body: CookiesDto) {
    return this.cookies.put(auth, body);
  }

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.cookies.list(auth);
  }

  @Delete()
  removeAll(@Auth() auth: AuthContext) {
    return this.cookies.remove(auth);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.cookies.remove(auth, id);
  }
}

/** Site logins (SPEC §4), only with SITE_CREDENTIALS_ENABLED=true. Write-only. */
@ApiTags('access')
@ApiBearerAuth()
@Controller('v1/credentials')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Put(':site')
  put(@Auth() auth: AuthContext, @Param('site') site: string, @Body() body: CredentialDto) {
    return this.credentials.put(auth, site, body);
  }

  @Delete(':site')
  remove(@Auth() auth: AuthContext, @Param('site') site: string) {
    return this.credentials.remove(auth, site);
  }
}
