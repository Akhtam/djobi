/**
 * Vitest setup for `apps/dashboard`: jest-dom matchers, RTL cleanup after each test, and a
 * no-op `IntersectionObserver` — jsdom has none, and any test that mounts the Analytics view
 * mounts `RequirementsPanel`'s scroll-reveal along with it, whether or not that test cares about
 * scrolling. `useRevealOnScroll.test.tsx` stubs its own instrumented fake over this default when it
 * needs to observe what the observer was actually asked to do.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
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
