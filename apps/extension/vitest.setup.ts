/** Vitest setup for `apps/extension`: jest-dom matchers + RTL cleanup after each test. */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
