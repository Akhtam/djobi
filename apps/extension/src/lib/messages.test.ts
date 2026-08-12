import type { Profile } from '@djobi/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from './messages';

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

describe('notify', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), lastError: undefined } });
  });

  it('sends the message via chrome.runtime.sendMessage', () => {
    notify({ type: 'START_FILL', tabId: 1, profile });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'START_FILL', tabId: 1, profile },
      expect.any(Function),
    );
  });

  it('reads runtime.lastError, so sending with no service worker listening is not an unchecked error', () => {
    // Chrome only treats `lastError` as handled once it has been read; leaving it alone logs a
    // console error the caller can do nothing about. There is nothing else to assert here — the
    // property access *is* the behaviour.
    const read = vi.fn(() => ({ message: 'Could not establish connection.' }));
    // Invoke the callback the way an unanswered send does: with no argument.
    const sendMessage = vi.fn((_message: unknown, callback: () => void) => callback());
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    Object.defineProperty(chrome.runtime, 'lastError', { get: read, configurable: true });

    notify({ type: 'START_FILL', tabId: 1, profile });

    expect(read).toHaveBeenCalled();
  });

  it('returns nothing — the protocol has no responses to wait on', () => {
    expect(notify({ type: 'START_FILL', tabId: 1, profile })).toBeUndefined();
  });
});
