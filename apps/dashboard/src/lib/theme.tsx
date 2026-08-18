/**
 * The dashboard's light/dark preference.
 *
 * A port of `apps/extension/src/lib/theme.tsx` rather than an import of it: that module persists
 * through `chrome.storage.local`, which does not exist on a plain web page. The markup and the two
 * icons are kept identical so the control looks the same in both surfaces.
 *
 * Unlike the extension's version this seeds from `prefers-color-scheme`, because a web page has a
 * meaningful OS-level default to inherit and an unconfigured extension page does not.
 */
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'djobi-dashboard-theme';

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * `localStorage`, or `undefined` where it isn't usable.
 *
 * The extension's version of this module guards `chrome.storage` for the same reason: the storage
 * a page persists to is not guaranteed to be there. Here it genuinely isn't in two cases that
 * matter — the jsdom environment the component tests run in exposes no `localStorage` at all, and a
 * browser with site data blocked *throws* on property access rather than returning null. Both would
 * otherwise take down the whole app at its first render, since the theme is read before anything
 * else is drawn.
 */
function themeStorage(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function preferredTheme(): Theme {
  const stored = themeStorage()?.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  // `matchMedia` is likewise absent in jsdom; an unconfigured page then defaults to light.
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Keeps the page on one persisted color preference. */
export function useThemePreference() {
  const [theme, setTheme] = useState<Theme>(preferredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    themeStorage()?.setItem(THEME_KEY, next);
  }

  return { theme, toggleTheme };
}

/** Compact control for switching between light and dark. Markup shared with the extension. */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const nextTheme = theme === 'light' ? 'dark' : 'light';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      {theme === 'light' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.4 15.5A8.5 8.5 0 0 1 8.5 3.6 8.5 8.5 0 1 0 20.4 15.5Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}
