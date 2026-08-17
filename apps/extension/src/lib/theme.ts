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
