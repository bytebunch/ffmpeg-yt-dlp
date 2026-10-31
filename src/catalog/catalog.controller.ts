import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { APP_CONFIG } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import { RecipesService } from '../recipes/recipes.service';
import { catalog } from './catalog';

/** Lets agents discover every option and its schema (SPEC §4, MCP `list_presets`). */
@ApiTags('discovery')
@ApiBearerAuth()
@Controller('v1')
export class CatalogController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly recipes: RecipesService,
  ) {}

  @Get('presets')
  async presets(@Auth() auth: AuthContext) {
    return catalog(this.config, (await this.recipes.list(auth.clientId)).recipes);
  }
}
