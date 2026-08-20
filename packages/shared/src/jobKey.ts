/**
 * A URL identity for a *job posting*, rather than for the ATS screen the candidate happens to be
 * looking at.
 *
 * Two things depend on this being stable across screens of one posting:
 *
 * - The extension scopes a Job Description draft to it, so collecting the posting on an overview
 *   route and then navigating to the application route doesn't erase the draft.
 * - The backend stores it alongside `job_url` and matches the Duplicate Guard on it, so a posting
 *   revisited through an ad link (`?gh_src=…`, `?utm_campaign=…`) is still recognized as one the
 *   candidate already applied to. Matching the raw URL alone missed exactly that case, and missing
 *   it costs three LLM calls and a re-application.
 *
 * It lives in `@djobi/shared` because both sides have to agree on it: a key the extension computes
 * one way and the backend another would silently stop matching.
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
 * Returns a URL identity for the job rather than for the current ATS screen.
 *
 * Ashby changes `/org/posting-id` to `/org/posting-id/application` with `pushState`; Lever uses a
 * similar `/apply` suffix. Treating those as separate pages is what used to erase the posting just
 * before it was needed. Other URLs retain their full path and meaningful query parameters, so a
 * navigation to another posting does not inherit stale data — and so a board that distinguishes two
 * postings by query string (Workday's `?jobId=`) keeps distinguishing them here.
 *
 * @param value - A browser URL, or nothing.
 * @returns The normalized key, or `null` if `value` is absent or isn't an http(s) URL.
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
