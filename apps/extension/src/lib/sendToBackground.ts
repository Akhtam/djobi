/**
 * Sends `{ path, body }` to the background service worker (`background/service-worker.ts`'s
 * `chrome.runtime.onMessage` relay) and resolves with the relayed backend response, or rejects
 * with the relayed error message. Used by extension pages (popup/options) that can't call
 * `callBackend` directly.
 */
export function sendToBackground<T>(
  path: string,
  body: unknown,
  method?: 'GET' | 'POST',
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ path, body, method }, (response: { data?: T; error?: string }) => {
      if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response.data as T);
      }
    });
  });
}
