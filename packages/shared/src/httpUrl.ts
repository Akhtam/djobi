/**
 * A usable posting URL: `http:` or `https:` only.
 *
 * zod's `.url()` alone accepts `javascript:` URLs, and a stored `jobUrl` is rendered as an
 * `<a href>` on the dashboard's origin (which holds the session cookie). Shared so the forms and
 * the `NewApplicationSchema` write boundary enforce the same rule as `jobKeyForUrl`.
 */
import { z } from 'zod';

/** True when `value` parses as a URL whose scheme is `http:` or `https:`. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A URL a posting can be served over. `z.url()` runs first so a non-URL gets zod's own message.
 */
export const HttpUrlSchema: z.ZodURL = z
  .url()
  .refine(isHttpUrl, { error: 'Must be an http(s) URL.' });
