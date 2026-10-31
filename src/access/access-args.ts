import type { SiteLogin } from './credentials.service';
import type { ExtractorArgs, SealedSecrets } from './options';

/** What a job's access options resolve to on the worker (SPEC §7f). */
export interface ResolvedAccess {
  /** Job-local copy of the user's cookie jar. */
  cookieFile?: string;
  login?: SiteLogin;
  secrets?: SealedSecrets;
  proxyUrl?: string;
  geoCountry?: string;
  markWatched?: boolean;
}

/** yt-dlp flags for resolved access; every value comes from the vault or the owner's config. */
export function accessArgs(access: ResolvedAccess): string[] {
  const args: string[] = [];
  if (access.cookieFile !== undefined) args.push('--cookies', access.cookieFile);
  if (access.login) {
    args.push('--username', access.login.username, '--password', access.login.password);
    if (access.login.twoFactor !== undefined) args.push('--twofactor', access.login.twoFactor);
  }
  if (access.secrets?.video_password !== undefined)
    args.push('--video-password', access.secrets.video_password);
  const tv = access.secrets?.tv_provider;
  if (tv) args.push('--ap-mso', tv.mso, '--ap-username', tv.username, '--ap-password', tv.password);
  if (access.proxyUrl !== undefined) args.push('--proxy', access.proxyUrl);
  if (access.geoCountry !== undefined) args.push('--xff', access.geoCountry);
  if (access.markWatched === true) args.push('--mark-watched');
  return args;
}

/**
 * One `--extractor-args youtube:` value from the comment settings and the whitelisted keys
 * (SPEC §7f), so no option overrides another by repeating the flag.
 */
export function youtubeExtractorArgs(
  extractorArgs: ExtractorArgs | undefined,
  comments?: { max: number; sort: string },
): string[] {
  const youtube = extractorArgs?.youtube;
  const maxComments = youtube?.max_comments ?? comments?.max;
  const pairs: [string, string | undefined][] = [
    ['player_client', youtube?.player_client?.join(',')],
    ['lang', youtube?.lang],
    ['max_comments', maxComments === undefined ? undefined : String(maxComments)],
    ['comment_sort', youtube?.comment_sort ?? comments?.sort],
  ];
  const value = pairs
    .flatMap(([key, entry]) => (entry === undefined ? [] : [`${key}=${entry}`]))
    .join(';');
  return value === '' ? [] : ['--extractor-args', `youtube:${value}`];
}

/**
 * The proxy for a run: the requested pool name, else PROXY_DEFAULT_BY_EXTRACTOR for the
 * extractor. Before extraction only the URL is known, so its host stands in for the extractor.
 */
export function selectProxy(
  pool: Record<string, string>,
  defaults: Record<string, string>,
  requested: string | undefined,
  extractorOrUrl: { extractor?: string; url?: string },
): string | undefined {
  if (requested !== undefined) return pool[requested];
  const extractor = extractorOrUrl.extractor?.toLowerCase().split(':')[0];
  const name =
    extractor !== undefined ? defaults[extractor] : hostDefault(defaults, extractorOrUrl.url);
  return name === undefined ? undefined : pool[name];
}

/** youtu.be and youtube-nocookie.com belong to the youtube extractor. */
const HOST_ALIASES: Record<string, string> = {
  'youtu.be': 'youtube',
  'youtube-nocookie.com': 'youtube',
};

function hostDefault(
  defaults: Record<string, string>,
  url: string | undefined,
): string | undefined {
  if (url === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [alias, extractor] of Object.entries(HOST_ALIASES)) {
    if ((host === alias || host.endsWith(`.${alias}`)) && defaults[extractor] !== undefined)
      return defaults[extractor];
  }
  const labels = host.split('.');
  const match = Object.keys(defaults).find((extractor) => labels.includes(extractor));
  return match === undefined ? undefined : defaults[match];
}
