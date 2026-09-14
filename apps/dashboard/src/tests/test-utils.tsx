/**
 * Shared rendering and fixture helpers for the feature-oriented test files in this directory.
 *
 * Splitting tests by feature does not mean replacing integration tests with isolated component
 * tests — every file here still drives the whole `<App>` through `createFixtureDashboardClient`,
 * the only substitution any of these tests make. Keep a helper here only once a second file needs
 * it; a helper used by one file belongs in that file, next to the tests it serves.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect } from 'vitest';
import { App } from '../App';
import { createFixtureDashboardClient, type DashboardClient } from '../lib/dashboardClient';
import { fixtureApplications } from '../lib/fixtures';

/**
 * Every test starts on the dashboard root, signed in, with a clean history — reset here rather
 * than in each file so a feature file can't forget it and leak `location.hash` into the next test.
 */
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.location.hash = '#/';
});

/**
 * Renders `<App>` against a fixture client (or a caller-supplied one) and starts `userEvent`,
 * optionally routing to `hash` first — the one piece of setup every test in this suite needs.
 */
export function renderDashboard(options: { client?: DashboardClient; hash?: string } = {}) {
  const { client = createFixtureDashboardClient(fixtureApplications), hash } = options;
  if (hash !== undefined) window.location.hash = hash;
  return { user: userEvent.setup(), ...render(<App client={client} />) };
}

/**
 * `count` applications, numbered so each has a findable role title. The fixtures are seven rows —
 * enough to exercise filtering, not enough to reach a second batch of `PAGE_SIZE`. Shared by the
 * applications-list pagination tests and the routing test that reloads a deep link mid-batch.
 */
export function manyApplications(count: number) {
  const template = fixtureApplications[0]!;
  return Array.from({ length: count }, (_, i) => ({
    ...structuredClone(template),
    id: `app-${i}`,
    roleTitle: `Engineer ${i}`,
    // Descending, so `Engineer 0` sorts first and the batches are in a predictable order.
    createdAt: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString(),
  }));
}

/** A promise plus its own `resolve`/`reject`, for tests that drive write-order by hand. */
export function deferred<T>() {
  return Promise.withResolvers<T>();
}

/**
 * Tabs forward until `target` has focus. The stage picker sits behind the back link, the theme
 * toggle and the job-url link, and counting those is a test that breaks whenever the header
 * changes — what matters here is only that the control is reachable by keyboard at all.
 */
export async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let i = 0; i < 12 && document.activeElement !== target; i++) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

/** The list renders one row per application; each row's detail link is the role title. */
export function rowFor(roleTitle: string): HTMLElement {
  return screen.getByRole('link', { name: roleTitle }).closest('[data-application-row]')!;
}
