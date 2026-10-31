import { z } from 'zod';

import type { AppConfig } from '../config/env.schema';
import { INFO_INCLUDES } from '../discovery/mappers';
import { DOWNLOAD_PRESETS, PRESET_DESCRIPTIONS } from '../discovery/presets';
import {
  commentsRequestSchema,
  infoRequestSchema,
  searchQuerySchema,
  transcriptRequestSchema,
} from '../discovery/schemas';
import { SEARCH_SITE_NAMES, siteAllowed } from '../discovery/search';
import { TRANSCRIPT_FORMATS } from '../discovery/subtitles';
import { inputSchema } from '../inputs/schemas';
import { batchJobSchema, downloadJobSchema, processJobSchema } from '../jobs/schemas';
import { stepSchema } from '../recipes/schema';

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });

/** Every recipe operation with the JSON Schema of its parameters (built once). */
let operations: { op: string; schema: unknown }[] | undefined;
function recipeOperations() {
  operations ??= stepSchema.options.map((option) => ({
    op: option.shape.op.value,
    schema: jsonSchema(option),
  }));
  return operations;
}

/**
 * What an agent needs to build any request (SPEC §4 GET /v1/presets, MCP `list_presets`):
 * download presets, discovery options, request schemas, recipe operations and named recipes.
 */
export function catalog(config: AppConfig, recipes: unknown[]) {
  return {
    download_presets: DOWNLOAD_PRESETS.map((name) => ({
      name,
      description: PRESET_DESCRIPTIONS[name],
    })),
    info_includes: INFO_INCLUDES,
    search_sites: SEARCH_SITE_NAMES.filter((site) => siteAllowed(site, config.SITE_ALLOWLIST)),
    transcript_formats: TRANSCRIPT_FORMATS,
    request_schemas: {
      info: jsonSchema(infoRequestSchema),
      search: jsonSchema(searchQuerySchema),
      transcripts: jsonSchema(transcriptRequestSchema),
      comments: jsonSchema(commentsRequestSchema),
      input: jsonSchema(inputSchema),
      download_job: jsonSchema(downloadJobSchema),
      batch_job: jsonSchema(batchJobSchema),
      process_job: jsonSchema(processJobSchema),
    },
    recipe_operations: recipeOperations(),
    recipes,
  };
}
