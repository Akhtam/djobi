/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Composes the two
 * kinds of `chrome.runtime.onMessage` traffic this extension handles: the untyped `{path,body,
 * method?}` relay to the local djobi backend (`relay.ts`), and typed content-script/popup
 * coordination messages (`router.ts`).
 */
import type { TypedMessage } from '../lib/messages';
import { handleRelayMessage, type RelayMessage } from './relay';
import { handleTypedMessage } from './router';

chrome.runtime.onMessage.addListener(
  (
    message: RelayMessage | TypedMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (!('type' in message)) {
      return handleRelayMessage(message, sendResponse);
    }
    return handleTypedMessage(message, sender, sendResponse);
  },
);
