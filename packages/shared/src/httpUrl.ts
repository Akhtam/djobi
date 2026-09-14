/**
 * What counts as a *usable* posting URL: `http:` or `https:` and nothing else.
 *
 * It lives here because it is a rule both processes have to agree on, and because the halves that
 * did agree on it were the two that mattered least. `apps/extension/src/panel/LogApplication.tsx`
 * and `apps/dashboard/src/views/NewApplication.tsx` each carried their own copy so a bad paste
 * fails in the form rather than as a 400 — but the write boundary itself, `NewApplicationSchema`'s
 * `jobUrl`, was `z.string().url()`, and zod's `.url()` is `new URL(value)` in a try/catch. That
 * accepts `javascript:alert(1)` exactly as readily as `https://…`.
 *
 * That is not a cosmetic difference. A stored `jobUrl` is rendered as an `<a href>` by the
 * dashboard's `PostingLink`, so a non-http scheme that reaches the database is a script URL one
 * click away from running on the dashboard's own origin — the origin holding the session cookie.
 * `jobKeyForUrl` already refused anything but http(s) for the *identity* of a posting; this is the
 * same rule stated for its storage.
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
 * A URL a posting can actually be served over.
 *
 * `z.url()` is kept in front of the refinement so a value that isn't a URL at all still reports
 * zod's own message rather than the scheme one, which would be misleading for a typo.
 */
export const HttpUrlSchema: z.ZodURL = z
  .url()
  .refine(isHttpUrl, { error: 'Must be an http(s) URL.' });
