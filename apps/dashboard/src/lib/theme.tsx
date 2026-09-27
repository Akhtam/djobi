/**
 * The dashboard's light/dark preference — a port of the extension's `lib/theme.tsx` persisting to
 * `localStorage` instead of `chrome.storage.local`, with identical markup. Defaults to dark;
 * `index.html` applies it before first paint.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_THEME, THEME_KEY } from './themeConstants';

export type Theme = 'light' | 'dark';

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * `localStorage`, or `undefined` where unusable (jsdom has none; blocked site data *throws* on
 * access) — the theme is read before anything renders, so this must never throw.
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
  return DEFAULT_THEME;
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
