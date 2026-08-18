import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'theme';

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function localThemeStorage() {
  return typeof chrome === 'undefined' ? undefined : chrome.storage.local;
}

/** Keeps the extension's independently-rendered pages on one persisted color preference. */
export function useThemePreference() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const storage = localThemeStorage();
    if (!storage) {
      applyTheme(theme);
      return;
    }

    let current = true;
    void storage.get(THEME_KEY).then((stored) => {
      const next: Theme = stored[THEME_KEY] === 'dark' ? 'dark' : 'light';
      if (!current) return;
      setTheme(next);
      applyTheme(next);
    });

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'local' || !(THEME_KEY in changes)) return;
      const next: Theme = changes[THEME_KEY].newValue === 'dark' ? 'dark' : 'light';
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
