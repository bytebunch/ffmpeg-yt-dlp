import { AppError } from '../common/errors';

interface SearchSite {
  /** The site's main extractor name, matched against SITE_ALLOWLIST. */
  extractor: string;
  /** yt-dlp search prefix ("ytsearch10:<query>") and the extractor that serves it. */
  key: string;
  searchExtractor: string;
  date?: { key: string; searchExtractor: string } | 'results-url';
}

/**
 * Sites with a yt-dlp search key (checked against yt-dlp 2026.10.26). YouTube no longer has
 * `ytsearchdate`; date order uses a results URL with the upload-date sort parameter instead.
 */
export const SEARCH_SITES = {
  youtube: {
    extractor: 'youtube',
    key: 'ytsearch',
    searchExtractor: 'youtube:search',
    date: 'results-url',
  },
  soundcloud: { extractor: 'soundcloud', key: 'scsearch', searchExtractor: 'soundcloud:search' },
  bilibili: { extractor: 'BiliBili', key: 'bilisearch', searchExtractor: 'BiliBiliSearch' },
  niconico: {
    extractor: 'niconico',
    key: 'nicosearch',
    searchExtractor: 'nicovideo:search',
    date: { key: 'nicosearchdate', searchExtractor: 'nicovideo:search:date' },
  },
} as const satisfies Record<string, SearchSite>;

export type SearchSiteName = keyof typeof SEARCH_SITES;
export const SEARCH_SITE_NAMES = Object.keys(SEARCH_SITES) as SearchSiteName[];

export interface SearchTarget {
  url: string;
  extractor: string;
  args: string[];
}

const YOUTUBE_UPLOAD_DATE_SORT = 'CAI%3D';

export function siteAllowed(site: SearchSiteName, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const names = [SEARCH_SITES[site].extractor, SEARCH_SITES[site].searchExtractor].map((name) =>
    name.toLowerCase(),
  );
  return allowlist.some((entry) => names.includes(entry.toLowerCase()));
}

/** The pseudo-URL, extractor and arguments for one search; the query never becomes a flag. */
export function searchTarget(
  site: SearchSiteName,
  sort: 'relevance' | 'date',
  query: string,
  limit: number,
): SearchTarget {
  const config: SearchSite = SEARCH_SITES[site];
  if (sort === 'relevance') {
    return { url: `${config.key}${limit}:${query}`, extractor: config.searchExtractor, args: [] };
  }
  if (config.date === 'results-url') {
    return {
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${YOUTUBE_UPLOAD_DATE_SORT}`,
      extractor: 'youtube:search_url',
      args: ['-I', `1:${limit}`],
    };
  }
  if (config.date === undefined) {
    throw new AppError('VALIDATION_FAILED', `Sorting by date is not available for ${site}`);
  }
  return {
    url: `${config.date.key}${limit}:${query}`,
    extractor: config.date.searchExtractor,
    args: [],
  };
}
