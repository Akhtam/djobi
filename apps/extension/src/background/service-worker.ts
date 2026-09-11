/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Listens for the
 * typed content-script/panel coordination messages and hands them to `router.ts`. Also wires
 * invalidation for `lib/tabStore/lifecycle.ts`'s per-tab session-storage entries so closing or
 * navigating a tab leaves no stale frames/run behind, and makes the toolbar icon open the side
 * panel (there's no `default_popup` to compete with it).
 *
 * One versioned message protocol is parsed here before `message.type` is read. Extension pages call
 * `lib/callBackend.ts` themselves rather than relaying HTTP requests through this worker.
 *
 * This module owns the two things that only exist because Chrome can stop a worker mid-operation:
 * the one-time recovery sweep every message waits behind, and the `.catch` that is the single place
 * a routed task's terminal rejection is logged.
 *
 * Every message but one is acknowledged synchronously with an empty reply and then routed as a
 * fire-and-forget task — see the listener below. `UPDATE_RUN` is the documented exception: it holds
 * the channel open and replies with whether the store actually wrote the edit, because a refusal
 * there produces no `chrome.storage.onChanged` event for the panel to learn it from otherwise.
 */
import { registerTabStateCleanup } from '../lib/tabStore/lifecycle';
import { recoverInterruptedPipelineRuns } from '../lib/tabStore/pipelineRun';
import { TypedMessageEnvelopeSchema, type TypedMessage } from '../lib/messages';
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

chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse) => {
  const parsed = TypedMessageEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    // Malformed input gets the same short-lived, empty acknowledgement every valid notification
    // does below — there is nothing to route, so nothing to wait for.
    sendResponse();
    console.warn('[djobi] dropped invalid background message', {
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      issues: parsed.error.issues.map(({ code, path }) => ({ code, path })),
    });
    return;
  }

  const message = parsed.data.payload;

  // `UPDATE_RUN` is the one message on this channel with a real reply — see `lib/messages.ts`'s
  // `updateRun` for why a store refusal has to reach the panel this way. Chrome only keeps a
  // channel open past this listener's return for a message this callback claims with `true`, so
  // this is the one case that does not acknowledge synchronously below.
  if (message.type === 'UPDATE_RUN') {
    // Answering a channel the panel has already closed throws ("Attempting to use a disconnected
    // port"). That is a benign close, not a failure: swallowing it here keeps it out of the
    // `.catch` below, which would otherwise log a routing error for it and then call
    // `sendResponse` a second time — throwing again, inside the catch handler, with nothing left
    // downstream to catch it.
    const answer = (result: void | { applied: boolean }) => {
      try {
        sendResponse(result);
      } catch {
        // The panel closed while the write was in flight. Nobody is waiting for this answer.
      }
    };

    void recoveryReady
      .then(() => handleTypedMessage(message, sender))
      .then(answer)
      .catch((error: unknown) => {
        console.error('[djobi] background message failed', {
          type: message.type,
          tabId: tabIdOf(message, sender),
          runId: message.runId,
          error,
        });
        // No confirmed write, so the caller treats this exactly like a refusal.
        answer({ applied: false });
      });
    return true;
  }

  // Acknowledge receipt synchronously, with no payload, so a sender callback does not mistake the
  // intentionally short-lived response channel for a delivery failure. The routed task remains
  // fire-and-forget and outlives the panel — see `lib/messages.ts`.
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
