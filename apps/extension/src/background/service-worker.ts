/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Listens for the
 * typed content-script/panel coordination messages and hands them to `router.ts`. Also wires
 * invalidation for `lib/tabStore.ts`'s per-tab session-storage entries so closing or navigating a
 * tab leaves no stale frames/run behind, and makes the toolbar icon open the side panel (there's no
 * `default_popup` to compete with it).
 *
 * One message protocol, so `message.type` is always present — the extension pages call
 * `lib/callBackend.ts` themselves rather than relaying through here.
 *
 * This module owns the two things that only exist because Chrome can stop a worker mid-operation:
 * the one-time recovery sweep every message waits behind, and the `.catch` that is the single place
 * a routed task's terminal rejection is logged.
 */
import { recoverInterruptedPipelineRuns, registerTabStateCleanup } from '../lib/tabStore';
import type { TypedMessage } from '../lib/messages';
import { handleTypedMessage } from './router';

registerTabStateCleanup();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Register the listener synchronously, but route every waking message only after this worker has
// repaired operations abandoned by its predecessor. Without one shared barrier, a startup sweep can
// read `analyzing` after this same worker has just written it and demote live work as interrupted.
const recoveryReady = recoverInterruptedPipelineRuns().catch((error: unknown) => {
  console.error('[djobi] interrupted pipeline recovery failed', error);
});

function tabIdOf(message: TypedMessage, sender: chrome.runtime.MessageSender): number | undefined {
  return 'tabId' in message ? message.tabId : sender.tab?.id;
}

// Acknowledge receipt synchronously, with no payload, so a sender callback does not mistake the
// intentionally short-lived response channel for a delivery failure. The routed task remains
// fire-and-forget and outlives the panel — see `lib/messages.ts`.
chrome.runtime.onMessage.addListener((message: TypedMessage, sender, sendResponse) => {
  sendResponse();
  void recoveryReady
    .then(() => handleTypedMessage(message, sender))
    .catch((error: unknown) => {
      console.error('[djobi] background message failed', {
        type: message.type,
        tabId: tabIdOf(message, sender),
        ...('runId' in message ? { runId: message.runId } : {}),
        error,
      });
    });
});
