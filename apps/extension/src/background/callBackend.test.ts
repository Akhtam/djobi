import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callBackend } from './callBackend';

describe('callBackend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the body as JSON to the local backend and resolves with the parsed response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ company: 'Acme' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend('/extract-job', { pageText: 'Senior Engineer at Acme...' });

    expect(result).toEqual({ company: 'Acme' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/extract-job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageText: 'Senior Engineer at Acme...' }),
    });
  });

  it('rejects with the backend error message when the response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'pageText is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(callBackend('/extract-job', {})).rejects.toThrow('pageText is required');
  });

  it('sends a bodyless GET request when method is "GET"', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ fullName: 'Jane Doe' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await callBackend('/profile', undefined, 'GET');

    expect(result).toEqual({ fullName: 'Jane Doe' });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5391/profile', { method: 'GET' });
  });
});
