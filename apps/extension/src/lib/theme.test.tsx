/**
 * The theme preference, which is the one piece of state the extension's two independently-rendered
 * pages share. The panel and the options page are separate documents with separate React roots, so
 * "shared" here means persisted and observed — a toggle in one has to reach the other while both
 * are open, which is what the `chrome.storage.onChanged` subscription is for.
 *
 * Both surfaces render this on every route, so its failure modes are total: the panel and the
 * options page draw the theme before anything else.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChrome } from './fakeChrome';
import { ThemeToggle, useThemePreference } from './theme';

/** A fake `chrome.storage.local`, which is where the preference lives — not `session`. */
function stubChromeWithLocal(stored: Record<string, unknown> = {}) {
  const { storage } = fakeChrome();
  const local = { ...stored };
  const listeners: ((
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void)[] = [];

  const chromeWithLocal = {
    ...(chrome as unknown as Record<string, unknown>),
    storage: {
      ...storage,
      local: {
        get: (key: string) => Promise.resolve({ [key]: local[key] }),
        set: (values: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: local[key], newValue: value };
            local[key] = value;
          }
          for (const listener of [...listeners]) listener(changes, 'local');
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        removeListener: (listener: (typeof listeners)[number]) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  };
  vi.stubGlobal('chrome', chromeWithLocal);

  return { local, notify: chromeWithLocal.storage.local.set };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('useThemePreference', () => {
  it('starts light and applies the stored preference once it has been read', async () => {
    stubChromeWithLocal({ theme: 'dark' });
    const { result } = renderHook(() => useThemePreference());

    await waitFor(() => expect(result.current.theme).toBe('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('reads anything that is not "dark" as light, including nothing stored at all', async () => {
    stubChromeWithLocal({ theme: 'solarized' });
    const { result } = renderHook(() => useThemePreference());

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(result.current.theme).toBe('light');
  });

  it('persists a toggle and applies it at once, rather than waiting for the store', async () => {
    const { local } = stubChromeWithLocal({ theme: 'light' });
    const { result } = renderHook(() => useThemePreference());
    await waitFor(() => expect(result.current.theme).toBe('light'));

    act(() => result.current.toggleTheme());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await waitFor(() => expect(local.theme).toBe('dark'));
  });

  /**
   * The panel and the options page are separate documents with separate React roots, so a toggle in
   * one reaches the other only through the store. Without the subscription the two would sit on
   * different themes until whichever was reopened.
   */
  it("follows a change made by the extension's other page", async () => {
    const { notify } = stubChromeWithLocal({ theme: 'light' });
    const { result } = renderHook(() => useThemePreference());
    await waitFor(() => expect(result.current.theme).toBe('light'));

    await act(async () => {
      await notify({ theme: 'dark' });
    });

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  /**
   * Outside an extension page — which is where a component test renders — there is no
   * `chrome.storage`. The theme still has to be applied, or every surface renders unstyled.
   */
  it('still applies a theme where there is no chrome.storage to read', () => {
    vi.stubGlobal('chrome', undefined);

    renderHook(() => useThemePreference());

    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it.each([
    ['light', 'Switch to dark mode'],
    ['dark', 'Switch to light mode'],
  ] as const)('names the theme it switches *to* from %s', (theme, label) => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme={theme} onToggle={onToggle} />);

    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveAttribute('title', label);
    button.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
