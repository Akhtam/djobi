/**
 * The lazy `db` proxy, which exists so that *importing* this module never requires a database.
 *
 * That is what lets a route test import `app.ts` — and with it every route file, and with those the
 * repositories — without a `.env`. It is also the pattern ADR-0001 names as the one to reuse for the
 * model client when this backend is ported to a Worker, where module scope is evaluated on cold
 * start and bindings are not reliably available there. Both make it worth pinning rather than
 * leaving as a property of how the module happens to be written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { Pool, drizzle } = vi.hoisted(() => ({
  // A `function`, not an arrow: `client.ts` calls `new Pool(...)`, and Vitest 4+ mocks throw when an
  // arrow implementation is constructed.
  Pool: vi.fn(function () {
    return { on: vi.fn() };
  }),
  drizzle: vi.fn(() => ({ select: () => 'a query builder' })),
}));

vi.mock('pg', () => ({ Pool }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle }));

/** A fresh module registry per case, since the resolved client is cached in module scope. */
async function importClient(databaseUrl?: string) {
  vi.resetModules();
  Pool.mockClear();
  drizzle.mockClear();
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  return import('./client.js');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('the database client', () => {
  it('imports without a DATABASE_URL, so a route test needs no .env to load the app', async () => {
    const { db } = await importClient(undefined);

    expect(db).toBeDefined();
    expect(Pool).not.toHaveBeenCalled();
  });

  it('names the missing configuration and how to supply it, on first use', async () => {
    const { db } = await importClient(undefined);

    expect(() => db.select).toThrow(/DATABASE_URL is not set/);
    expect(() => db.select).toThrow(/apps\/backend\/\.env\.example/);
  });

  it('connects on first use, and once — every later property comes from the same client', async () => {
    const { db } = await importClient('postgres://user:pw@localhost/db');

    expect(db.select).toBeDefined();
    expect(db.select).toBeDefined();

    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({ connectionString: 'postgres://user:pw@localhost/db' });
    expect(drizzle).toHaveBeenCalledTimes(1);
  });
});
