/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Composes the two
 * kinds of `chrome.runtime.onMessage` traffic this extension handles: the untyped `{path,body,
 * method?}` relay to the local djobi backend (`relay.ts`), and typed content-script/panel
 * coordination messages (`router.ts`). Also wires cleanup for `lib/tabStore.ts`'s
 * per-tab session-storage entries so a closed tab leaves nothing behind, and
 * makes the toolbar icon open the side panel (there's no `default_popup` to compete with it).
 */
import { registerTabStateCleanup } from '../lib/tabStore';
import type { TypedMessage } from '../lib/messages';
import { handleRelayMessage, type RelayMessage } from './relay';
import { handleTypedMessage } from './router';

registerTabStateCleanup();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
