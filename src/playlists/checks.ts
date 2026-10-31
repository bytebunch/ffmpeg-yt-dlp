import type { Filters } from './filters';

/** Date and metadata rules re-checked per item on full metadata (SPEC §7e). */
export interface ItemChecks {
  date_after?: string;
  date_before?: string;
  filters?: Filters;
}

/**
 * The options of each item expanded from a playlist request: the download options, the
 * pipeline, the sealed secrets, single mode, and the checks flat entries could not decide.
 */
export function itemJobOptions(
  stored: Record<string, unknown>,
  parts: Record<string, unknown>,
): Record<string, unknown> {
  const checks: ItemChecks = {
    ...(typeof stored.date_after === 'string' && { date_after: stored.date_after }),
    ...(typeof stored.date_before === 'string' && { date_before: stored.date_before }),
    ...(stored.filters !== undefined && { filters: stored.filters as Filters }),
  };
  return { ...parts, mode: 'single', ...(Object.keys(checks).length > 0 && { checks }) };
}
