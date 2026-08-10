import { callBackend } from './callBackend';

/** The legacy, untyped `{ path, body, method? }` shape relayed to the local djobi backend. */
export interface RelayMessage {
  path: string;
  body: unknown;
  method?: 'GET' | 'POST';
}

/** Relays `message` to `callBackend`, responding with `{ data }` on success or `{ error }` on failure. */
export function handleRelayMessage(
  message: RelayMessage,
  sendResponse: (response: unknown) => void,
): boolean {
  callBackend(message.path, message.body, message.method)
    .then((data) => sendResponse({ data }))
    .catch((error: Error) => sendResponse({ error: error.message }));
  return true;
}
