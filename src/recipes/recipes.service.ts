import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { APP_CONFIG, DATABASE } from '../common/tokens';
import type { AppConfig } from '../config/env.schema';
import type { Database } from '../db/database';
import { recipes } from '../db/schema';
import { PRESETS, presetList, presetSteps, RECIPE_NAME } from './presets';
import { parseRecipe } from './validate';

export interface RecipeView {
  name: string;
  builtin: boolean;
  description: string | null;
  params?: string[];
  steps?: unknown[];
  updated_at?: string;
}

/**
 * Named recipes (SPEC §8a): built-in presets and a client's saved recipes. Jobs store the
 * expanded steps, so editing a saved recipe never changes a job already queued.
 */
@Injectable()
export class RecipesService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** `recipe` as sent → `{ steps }`, plus the name it came from. */
  async resolve(clientId: string, ref: unknown): Promise<{ recipe: unknown; name?: string }> {
    if (typeof ref === 'string')
      return { recipe: { name: ref, steps: await this.stepsOf(clientId, ref) }, name: ref };
    if (typeof ref === 'object' && ref !== null && 'preset' in ref) {
      const { preset, params, ...rest } = ref as { preset: unknown; params?: unknown };
      if (typeof preset !== 'string' || Object.keys(rest).length > 0) {
        throw new AppError(
          'RECIPE_INVALID',
          'A preset reference is { "preset": name, "params": { … } }',
        );
      }
      const steps = presetSteps(preset, params);
      if (!steps) throw new AppError('RECIPE_INVALID', `There is no built-in recipe "${preset}"`);
      return { recipe: { name: preset, steps }, name: preset };
    }
    return { recipe: ref };
  }

  private async stepsOf(clientId: string, name: string): Promise<unknown[]> {
    const builtin = presetSteps(name);
    if (builtin) return builtin;
    const [saved] = await this.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.clientId, clientId), eq(recipes.name, name)));
    if (!saved)
      throw new AppError('RECIPE_INVALID', `There is no recipe "${name}" (see GET /v1/recipes)`);
    return saved.steps as unknown[];
  }

  async list(clientId: string): Promise<{ recipes: RecipeView[] }> {
    const saved = await this.db
      .select()
      .from(recipes)
      .where(eq(recipes.clientId, clientId))
      .orderBy(asc(recipes.name));
    return {
      recipes: [
        ...presetList(),
        ...saved.map((recipe) => ({
          name: recipe.name,
          builtin: false,
          description: recipe.description,
          updated_at: recipe.updatedAt.toISOString(),
        })),
      ],
    };
  }

  async get(clientId: string, name: string): Promise<RecipeView> {
    const builtin = PRESETS[name];
    if (builtin) {
      const params = presetList().find((entry) => entry.name === name)?.params ?? [];
      // Presets with required parameters (clip) have no fixed steps to show.
      let steps: unknown[] | undefined;
      try {
        steps = presetSteps(name, {});
      } catch {
        steps = undefined;
      }
      return {
        name,
        builtin: true,
        description: builtin.description,
        params,
        ...(steps && { steps }),
      };
    }
    const [saved] = await this.db
      .select()
      .from(recipes)
      .where(and(eq(recipes.clientId, clientId), eq(recipes.name, name)));
    if (!saved) throw new AppError('NOT_FOUND', `There is no recipe "${name}"`);
    return {
      name: saved.name,
      builtin: false,
      description: saved.description,
      steps: saved.steps as unknown[],
      updated_at: saved.updatedAt.toISOString(),
    };
  }

  /** Creates or replaces a saved recipe after validating it like a job's recipe. */
  async put(
    clientId: string,
    name: string,
    body: { steps: unknown[]; description?: string | undefined },
  ): Promise<RecipeView> {
    if (!RECIPE_NAME.test(name))
      throw new AppError('VALIDATION_FAILED', 'Recipe names are a-z, 0-9, _ and -, up to 64');
    if (name in PRESETS) throw new AppError('VALIDATION_FAILED', `"${name}" is a built-in recipe`);
    parseRecipe({ steps: body.steps }, this.config);
    const now = new Date();
    await this.db
      .insert(recipes)
      .values({ clientId, name, description: body.description ?? null, steps: body.steps })
      .onConflictDoUpdate({
        target: [recipes.clientId, recipes.name],
        set: { steps: body.steps, description: body.description ?? null, updatedAt: now },
      });
    return this.get(clientId, name);
  }

  async remove(clientId: string, name: string): Promise<{ deleted: true }> {
    const removed = await this.db
      .delete(recipes)
      .where(and(eq(recipes.clientId, clientId), eq(recipes.name, name)))
      .returning({ id: recipes.id });
    if (removed.length === 0) throw new AppError('NOT_FOUND', `There is no saved recipe "${name}"`);
    return { deleted: true };
  }
}
