/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Listens for the
 * typed content-script/panel coordination messages and hands them to `router.ts`. Also wires
 * cleanup for `lib/tabStore.ts`'s per-tab session-storage entries so a closed tab leaves nothing
 * behind, and makes the toolbar icon open the side panel (there's no `default_popup` to compete
 * with it).
 *
 * This used to multiplex a second, untyped `{ path, body, method? }` protocol onto the same
 * listener, relaying it to the backend on the extension pages' behalf. They call
 * `lib/callBackend.ts` directly now, so there is one message protocol here and `message.type` is
 * always present.
 */
import { registerTabStateCleanup } from '../lib/tabStore';
import type { TypedMessage } from '../lib/messages';
import { handleTypedMessage } from './router';

registerTabStateCleanup();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Returns nothing on purpose. Chrome keeps the message channel open only when a listener returns
// `true`, and every message in this protocol is a notification — see `lib/messages.ts`.
chrome.runtime.onMessage.addListener((message: TypedMessage, sender) => {
  handleTypedMessage(message, sender);
});
