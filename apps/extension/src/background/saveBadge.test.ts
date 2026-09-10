import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSavedBadge, showSavedBadge } from './saveBadge';

function stubAction(overrides: { setBadgeText?: () => Promise<void> } = {}) {
  const setBadgeText = vi.fn(overrides.setBadgeText ?? (() => Promise.resolve()));
  const setBadgeBackgroundColor = vi.fn(() => Promise.resolve());
  vi.stubGlobal('chrome', { action: { setBadgeText, setBadgeBackgroundColor } });
  return { setBadgeText, setBadgeBackgroundColor };
}

describe('saveBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks only the tab the application was saved from', async () => {
    const { setBadgeText, setBadgeBackgroundColor } = stubAction();

    await showSavedBadge(7);

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '✓' });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: expect.any(String) });
  });

  it('clears the tab that a new run is replacing', async () => {
    const { setBadgeText } = stubAction();

    await clearSavedBadge(7);

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' });
  });

  it('stays quiet when the tab is already gone, since a save that landed is still saved', async () => {
    stubAction({ setBadgeText: () => Promise.reject(new Error('No tab with id: 7.')) });

    await expect(showSavedBadge(7)).resolves.toBeUndefined();
  });
});
