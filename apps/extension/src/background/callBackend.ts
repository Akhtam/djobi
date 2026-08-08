const BACKEND_ORIGIN = 'http://127.0.0.1:5391';

/** Posts `body` as JSON to the local djobi backend and resolves with the parsed JSON response. */
export async function callBackend<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error ?? `Backend request to ${path} failed with status ${res.status}`);
  }

  return data as T;
}
