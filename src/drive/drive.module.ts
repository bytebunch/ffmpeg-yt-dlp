import { Module } from '@nestjs/common';

import { DriveConnections } from './drive-connections.service';
import { DriveController } from './drive.controller';
import { GoogleOAuth } from './google-oauth';

@Module({
  controllers: [DriveController],
  providers: [GoogleOAuth, DriveConnections],
  exports: [GoogleOAuth, DriveConnections],
})
export class DriveModule {}
