/**
 * Vitest setup: jest-dom matchers, RTL cleanup, and a no-op `IntersectionObserver` (jsdom has none;
 * the Analytics view mounts `useRevealOnScroll`).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// `findBy*`/`waitFor` give up after 1s by default. The first test in a file pays for React and the
// app loading into a cold jsdom, which on a shared CI runner can take longer than that.
configure({ asyncUtilTimeout: 5000 });

class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);

afterEach(() => {
  cleanup();
});
