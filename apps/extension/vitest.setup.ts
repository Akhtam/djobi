/** Vitest setup for `apps/extension`: jest-dom matchers + RTL cleanup after each test. */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// `findBy*`/`waitFor` give up after 1s by default. The first test in a file pays for React and the
// app loading into a cold jsdom, which on a shared CI runner can take longer than that.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
