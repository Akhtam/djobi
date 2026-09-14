/**
 * `index.html` carries its own copy of `THEME_KEY`/`DEFAULT_THEME` as literals — not an import of
 * this module — because its pre-paint script has to run synchronously, inline, before any other
 * script: a `type="module"` import is deferred by spec and would let the page paint (in the wrong
 * theme) before the import resolves, reintroducing the exact flash the script exists to prevent.
 * This test is what keeps that hand-copied pair from drifting instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_KEY } from './themeConstants';

// Resolved from this file, not `process.cwd()`: nothing sets vitest's `root`, so a cwd-relative
// path only finds `index.html` when the runner happens to be invoked from this package (as
// `pnpm -r run test` does) and throws ENOENT — rather than reporting drift — when it isn't.
// `fileURLToPath(import.meta.url)` is not the way to get there either: the jsdom environment
// replaces the global `URL`, and `node:url` rejects the instance it produces.
const indexHtmlPath = resolve(import.meta.dirname, '../../index.html');

describe('index.html theme bootstrap', () => {
  it('reads the same storage key this module exports', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');
    expect(html).toContain(`localStorage.getItem('${THEME_KEY}')`);
  });

  it('defaults to the same theme this module exports', () => {
    const html = readFileSync(indexHtmlPath, 'utf8');
    expect(html).toContain(`var theme = '${DEFAULT_THEME}'`);
  });
});
