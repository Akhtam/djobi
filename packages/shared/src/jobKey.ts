/**
 * A URL identity for a *job posting*, stable across that posting's ATS screens and ad-link query
 * params. The extension scopes Job Context to it; the backend stores it and matches the Duplicate
 * Guard on it. Shared so both sides derive it identically.
 */

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
 * A URL identity for the job rather than the current ATS screen: strips Ashby's `/application`
 * and Lever's `/apply` suffixes and tracking params, but keeps the rest of the path and meaningful
 * query params (e.g. Workday's `?jobId=`) so distinct postings stay distinct.
 *
 * @returns The key, or `null` if `value` is absent or not an http(s) URL.
 */
export function jobKeyForUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Plain fragments are anchors and dropped; `#/…` and `#!/…` are SPA routes that identify a job.
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
