import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'theme';

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function localThemeStorage() {
  return typeof chrome === 'undefined' ? undefined : chrome.storage.local;
}

/**
 * Keeps the extension's independently-rendered pages on one persisted color preference.
 *
 * New installs start in dark mode; an explicitly saved preference takes precedence.
 * `chrome.storage.local` has no synchronous read, so the initial render (and the no-storage
 * fallback) use the same dark default the async lookup below falls back to — there is a brief
 * window before that lookup resolves, but never one where the default itself disagrees.
 *
 * `panel/index.html` and `options/index.html` ship `data-theme="dark"` on `<html>` for the same
 * reason, and it is load-bearing rather than redundant: the stylesheets' own `:root` is the *light*
 * theme, so without it every side-panel open would paint a full white page before this hook's first
 * effect ran. A stored `'light'` still overrides it on mount.
 */
export function useThemePreference() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    // Applied synchronously (not left to the async lookup below) so the dark default is on the
    // page before `chrome.storage.local.get` — which has no synchronous form — resolves.
    applyTheme(theme);

    const storage = localThemeStorage();
    if (!storage) return;

    let current = true;
    void storage.get(THEME_KEY).then((stored) => {
      const next: Theme = stored[THEME_KEY] === 'light' ? 'light' : 'dark';
      if (!current) return;
      setTheme(next);
      applyTheme(next);
    });

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'local' || !(THEME_KEY in changes)) return;
      const next: Theme = changes[THEME_KEY].newValue === 'light' ? 'light' : 'dark';
      setTheme(next);
      applyTheme(next);
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      current = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
    void localThemeStorage()?.set({ [THEME_KEY]: next });
  }

  return { theme, toggleTheme };
}

/** Compact shared control for switching between the extension's light and dark themes. */
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
