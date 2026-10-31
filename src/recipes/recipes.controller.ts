import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { AuthContext } from '../auth/api-keys';
import { Auth } from '../auth/request-auth';
import { RecipesService } from './recipes.service';

class SaveRecipeDto extends createZodDto(
  z.strictObject({
    steps: z.array(z.unknown()).min(1).max(500),
    description: z.string().max(500).optional(),
  }),
) {}

/** SPEC §4: built-in and saved recipes; saved ones belong to the API key's client. */
@ApiTags('recipes')
@ApiBearerAuth()
@Controller('v1/recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.recipes.list(auth.clientId);
  }

  @Get(':name')
  get(@Auth() auth: AuthContext, @Param('name') name: string) {
    return this.recipes.get(auth.clientId, name);
  }

  @Put(':name')
  put(@Auth() auth: AuthContext, @Param('name') name: string, @Body() body: SaveRecipeDto) {
    return this.recipes.put(auth.clientId, name, body);
  }

  @Delete(':name')
  remove(@Auth() auth: AuthContext, @Param('name') name: string) {
    return this.recipes.remove(auth.clientId, name);
  }
}
