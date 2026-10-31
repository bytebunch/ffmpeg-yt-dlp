import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AccessModule } from '../access/access.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { DriveModule } from '../drive/drive.module';
import { ArchiveController } from '../archive/archive.controller';
import { ArchiveService } from '../archive/archive.service';
import { CatalogController } from '../catalog/catalog.controller';
import { LinksController } from '../links/links.controller';
import { ItemCoordinator } from '../playlists/coordinator';
import { RecipesController } from '../recipes/recipes.controller';
import { RecipesService } from '../recipes/recipes.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { DOWNLOAD_QUEUE, FFMPEG_QUEUE } from './queues';

@Module({
  imports: [
    BullModule.registerQueue({ name: DOWNLOAD_QUEUE }, { name: FFMPEG_QUEUE }),
    DiscoveryModule,
    AccessModule,
    DriveModule,
  ],
  controllers: [
    JobsController,
    LinksController,
    ArchiveController,
    RecipesController,
    CatalogController,
  ],
  providers: [JobsService, ItemCoordinator, RecipesService, ArchiveService],
  exports: [JobsService, RecipesService, ArchiveService],
})
export class JobsModule {}
