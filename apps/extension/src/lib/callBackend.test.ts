/**
 * `callBackend.ts`'s whole job is configuring `@djobi/http-client`'s transport for this extension —
 * the protocol itself (method defaults, error handling, auth header, abort combination) is that
 * package's own behaviour and has its own test file. This one asserts only what this module adds:
 * which origin, which token lookup, and what the unreachable-backend message says.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationWriteResultSchema } from '@djobi/shared';
import { EXTENSION_BACKEND_ORIGIN } from '../extensionConfig';
import { fakeSessionStorage } from './fakeSessionStorage';
import { setAuthToken } from './authToken';
import { transport } from './callBackend';

const Result = ApplicationWriteResultSchema;

describe('the extension backend transport', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('chrome', { storage: fakeSessionStorage() });
  });

  it("prefixes every call with the extension's configured backend origin", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'application-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await transport.json('/extract-job', Result, { method: 'POST', body: {} });

    expect(fetch).toHaveBeenCalledWith(
      `${EXTENSION_BACKEND_ORIGIN}/extract-job`,
      expect.anything(),
    );
  });

  it('attaches whatever bearer token chrome.storage.session currently holds', async () => {
    await setAuthToken('a-stored-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'application-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await transport.json('/extract-job', Result, { method: 'POST', body: {} });

    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer a-stored-token' }),
      }),
    );
  });

  it('sends no Authorization header when no token is stored', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 'application-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await transport.json('/extract-job', Result, { method: 'POST', body: {} });

    const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers;
    expect(headers).not.toHaveProperty('authorization');
  });

  it('names the origin, the dev-server command, and the reload requirement when nothing answers', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await transport
      .json('/extract-job', Result, { method: 'POST', body: {} })
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(EXTENSION_BACKEND_ORIGIN);
    expect((error as Error).message).toContain('pnpm dev:backend');
    expect((error as Error).message).toContain('reloaded');
  });
});
