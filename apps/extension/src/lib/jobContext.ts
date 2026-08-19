/** Where the editable Job Description draft originally came from. */
export type JobDescriptionSource = 'manual' | 'scraped';

/**
 * The Job Description that belongs to the job currently open in a tab.
 *
 * It is separate from an Analysis run because candidates commonly collect the posting on an ATS
 * overview route, then navigate to an application route before they analyze it. The draft therefore
 * has to exist before a run does and survive that same-job navigation.
 */
export interface JobContext {
  /** Stable across overview/application routes for the same posting. */
  jobKey: string;
  /** The page the description came from; used as the canonical saved/duplicate-check URL. */
  sourceUrl: string;
  jobDescription: string;
  source: JobDescriptionSource;
}

const APPLICATION_ROUTE = /\/(?:application|apply)\/?$/i;
const TRACKING_PARAMS = new Set(['gh_src', 'source', 'lever-source']);

function normalizeRoute(url: URL): void {
  url.pathname = url.pathname.replace(/\/+$/, '').replace(APPLICATION_ROUTE, '') || '/';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
}

/**
 * Returns a URL identity for the job rather than for the current ATS screen.
 *
 * Ashby changes `/org/posting-id` to `/org/posting-id/application` with `pushState`; Lever uses a
 * similar `/apply` suffix. Treating those as separate pages is what used to erase the posting just
 * before it was needed. Other URLs retain their full path and meaningful query parameters, so a
 * navigation to another posting does not inherit stale data.
 */
export function jobKeyForUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Ordinary fragments are document anchors and do not identify a job. `#/...` and `#!/...`,
    // however, are SPA routes: dropping them would make every job in a hash-routed careers app
    // share one context and carry the previous posting's resume/answers into the next one.
    const hashRoutePrefix = url.hash.startsWith('#!/')
      ? '#!'
      : url.hash.startsWith('#/')
        ? '#'
        : null;
    let hashRoute = '';
    if (hashRoutePrefix) {
      const route = new URL(url.hash.slice(hashRoutePrefix.length), 'https://hash-route.invalid');
      normalizeRoute(route);
      hashRoute = `${hashRoutePrefix}${route.pathname}${route.search}`;
    }

    url.hash = '';
    normalizeRoute(url);
    return `${url.toString()}${hashRoute}`;
  } catch {
    return null;
  }
}

/** Whether two browser URLs are screens belonging to the same job posting. */
export function isSameJobUrl(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  const firstKey = jobKeyForUrl(first);
  const secondKey = jobKeyForUrl(second);
  return firstKey !== null && secondKey !== null && firstKey === secondKey;
}
