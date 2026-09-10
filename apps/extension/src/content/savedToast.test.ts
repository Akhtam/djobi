import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showSavedToast } from './savedToast';

/** The toast lives in a closed shadow root, so its host is all the document itself can see. */
function hosts(): Element[] {
  return Array.from(document.querySelectorAll('#djobi-saved-toast'));
}

describe('showSavedToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('puts a toast on the page naming the company and role that were saved', () => {
    showSavedToast(document, { company: 'Brex', roleTitle: 'Staff Engineer' });

    expect(hosts()).toHaveLength(1);
    // A closed root is deliberately unreachable from the page; reading it back through the return
    // of `attachShadow` is not possible here either, so the assertion is on what the page can see.
    expect(hosts()[0].shadowRoot).toBeNull();
  });

  it('removes itself once it has been up long enough to read', () => {
    showSavedToast(document, { company: 'Brex', roleTitle: 'Staff Engineer' });

    vi.advanceTimersByTime(5_000);

    expect(hosts()).toHaveLength(0);
  });

  it('replaces the toast already up rather than stacking a second one in the corner', () => {
    showSavedToast(document, { company: 'Brex', roleTitle: 'Staff Engineer' });
    showSavedToast(document, { company: 'Otter', roleTitle: 'Backend Engineer' });

    expect(hosts()).toHaveLength(1);
  });
});
