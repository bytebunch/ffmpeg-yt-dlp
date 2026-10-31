import { Module } from '@nestjs/common';

import { DiscoveryModule } from '../discovery/discovery.module';
import { DriveModule } from '../drive/drive.module';
import { JobsModule } from '../jobs/jobs.module';
import { UploadsController } from '../uploads/uploads.controller';
import { UploadsService } from '../uploads/uploads.service';
import { InputsController } from './inputs.controller';
import { InputsService } from './inputs.service';
import { InputResolver } from './resolver';

@Module({
  imports: [DiscoveryModule, JobsModule, DriveModule],
  controllers: [InputsController, UploadsController],
  providers: [InputResolver, UploadsService, InputsService],
  exports: [InputResolver, UploadsService, InputsService],
})
export class InputsModule {}
