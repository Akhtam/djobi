const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/**
 * Sends `body` as JSON to the local djobi backend and resolves with the parsed JSON response.
 * `method` defaults to `POST`; `GET` requests are sent bodyless.
 */
export async function callBackend<T>(
  path: string,
  body: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const res = await fetch(
    `${BACKEND_ORIGIN}${path}`,
    method === 'GET'
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error ?? `Backend request to ${path} failed with status ${res.status}`);
  }

  return data as T;
}
