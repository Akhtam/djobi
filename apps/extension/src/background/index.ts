/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Relays
 * `chrome.runtime.sendMessage({ path, body })` calls from the popup/content script to
 * `callBackend.ts`, responding with `{ data }` on success or `{ error }` on failure.
 */
import { callBackend } from './callBackend';

interface RelayMessage {
  path: string;
  body: unknown;
  method?: 'GET' | 'POST';
}

chrome.runtime.onMessage.addListener((message: RelayMessage, _sender, sendResponse) => {
  callBackend(message.path, message.body, message.method)
    .then((data) => sendResponse({ data }))
    .catch((error: Error) => sendResponse({ error: error.message }));

  return true;
});
