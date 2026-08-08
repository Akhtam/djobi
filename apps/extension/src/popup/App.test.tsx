import type { Profile } from '@djobi/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
};

/** Stubs `chrome.tabs.query` (active tab URL) and `chrome.runtime` (profile fetch + options page). */
function stubChrome(options: { tabUrl: string; profileResponse: { data?: unknown } }) {
  const openOptionsPage = vi.fn();
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(
        (_query: unknown, callback: (tabs: { url: string }[]) => void) =>
          callback([{ url: options.tabUrl }]),
      ),
    },
    runtime: {
      sendMessage: vi.fn(
        (_message: unknown, callback: (response: unknown) => void) =>
          callback(options.profileResponse),
      ),
      openOptionsPage,
    },
  });
  return { openOptionsPage };
}

describe('popup App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('prompts to set up a profile when none exists yet', async () => {
    const { openOptionsPage } = stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profileResponse: { data: null },
    });

    render(<App />);

    await screen.findByText('Set up your profile to get started.');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile settings' }));
    expect(openOptionsPage).toHaveBeenCalled();
  });

  it('prompts to navigate to a supported page when the profile exists but the tab is unsupported', async () => {
    stubChrome({ tabUrl: 'https://example.com', profileResponse: { data: profile } });

    render(<App />);

    await screen.findByText('Navigate to a supported job application page to get started.');
  });

  it('shows a ready state when the profile exists and the tab is a supported ATS host', async () => {
    stubChrome({
      tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      profileResponse: { data: profile },
    });

    render(<App />);

    await screen.findByText('djobi is ready on this page.');
  });
});
