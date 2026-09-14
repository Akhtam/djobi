/**
 * The dashboard's theme preference — a port of the extension's, differing in the two places that
 * matter: it persists to `localStorage`, and new visitors default to dark mode.
 *
 * Both of those are guarded rather than assumed, and the guards are the point: a browser with site
 * data blocked *throws* on `localStorage` access. The theme is read before anything else is drawn,
 * so that would otherwise take the whole app down at its first render.
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle, useThemePreference } from './theme';

const THEME_KEY = 'djobi-dashboard-theme';

/**
 * An in-memory `localStorage`.
 *
 * jsdom exposes none at all in this configuration, which is one of the two absences the module
 * guards against — and which is why a test that wants to assert on persistence has to supply one.
 */
function stubStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
  return store;
}

/** Makes every `localStorage` access throw, as a browser with site data blocked does. */
function stubBlockedStorage() {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Access to storage is not allowed from this context.');
    },
  });
}

let realLocalStorage: PropertyDescriptor | null | undefined;

beforeEach(() => {
  realLocalStorage ??= Object.getOwnPropertyDescriptor(window, 'localStorage') ?? null;
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (realLocalStorage) Object.defineProperty(window, 'localStorage', realLocalStorage);
  else delete (window as { localStorage?: unknown }).localStorage;
});

describe('useThemePreference', () => {
  it('applies the stored preference on the first render', () => {
    stubStorage({ [THEME_KEY]: 'dark' });

    const { result } = renderHook(() => useThemePreference());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('defaults to dark when nothing is stored', () => {
    const { result } = renderHook(() => useThemePreference());

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    stubStorage({ [THEME_KEY]: 'solarized' });
    expect(renderHook(() => useThemePreference()).result.current.theme).toBe('dark');
  });

  it('persists a toggle and applies it', () => {
    const store = stubStorage();
    const { result } = renderHook(() => useThemePreference());

    act(() => result.current.toggleTheme());

    expect(result.current.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(store.get(THEME_KEY)).toBe('light');
  });

  /**
   * The absence jsdom itself presents, and a real one: a page whose browser exposes no
   * `localStorage` still has to render with the dark default.
   */
  it('renders where there is no localStorage at all', () => {
    expect(renderHook(() => useThemePreference()).result.current.theme).toBe('dark');
  });

  /**
   * Site data blocked. Reading the preference must not throw, and neither must writing one — the
   * candidate simply gets a theme that doesn't outlive the page.
   */
  it('renders and toggles where localStorage access throws', () => {
    stubBlockedStorage();
    const { result } = renderHook(() => useThemePreference());
    expect(result.current.theme).toBe('dark');

    expect(() => act(() => result.current.toggleTheme())).not.toThrow();
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
