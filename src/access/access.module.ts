import { Module } from '@nestjs/common';

import { CookiesController, CredentialsController } from './access.controller';
import { CookiesService } from './cookies.service';
import { CredentialsService } from './credentials.service';
import { JobAccessResolver } from './job-access';

@Module({
  controllers: [CookiesController, CredentialsController],
  providers: [CookiesService, CredentialsService, JobAccessResolver],
  exports: [CookiesService, CredentialsService, JobAccessResolver],
})
export class AccessModule {}
