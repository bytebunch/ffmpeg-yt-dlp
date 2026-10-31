import { Module } from '@nestjs/common';

import { CookiesController, CredentialsController } from './access.controller';
import { CookiesService } from './cookies.service';
import { CredentialsService } from './credentials.service';

@Module({
  controllers: [CookiesController, CredentialsController],
  providers: [CookiesService, CredentialsService],
  exports: [CookiesService, CredentialsService],
})
export class AccessModule {}
