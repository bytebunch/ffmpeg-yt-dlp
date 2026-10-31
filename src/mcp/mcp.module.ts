import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { DriveModule } from '../drive/drive.module';
import { InputsModule } from '../inputs/inputs.module';
import { JobsModule } from '../jobs/jobs.module';
import { WatchesModule } from '../watches/watches.module';
import { McpController } from './mcp.controller';
import { McpTools } from './mcp.tools';

@Module({
  imports: [DiscoveryModule, JobsModule, InputsModule, AccessModule, WatchesModule, DriveModule],
  controllers: [McpController],
  providers: [McpTools],
})
export class McpModule {}
