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
 * Most messages are acknowledged synchronously with an empty reply and then routed as a
 * fire-and-forget task — see the listener below. `UPDATE_RUN`, `START_FILL` and
 * `START_SAVE_APPLICATION` are the documented exceptions: each holds the channel open and replies
 * with a real answer — whether the store actually wrote the edit, or whether the claim was won —
 * because a refusal to any of them produces no `chrome.storage.onChanged` event for the panel to
 * learn it from otherwise. `START_FILL`/`START_SAVE_APPLICATION`'s reply is about the claim only;
 * the step itself keeps running underneath exactly as it always did, checkpointing its own progress
 * into the store — see `background/router.ts`.
 */
import { registerTabStateCleanup } from '../lib/tabStore/lifecycle';
import { recoverInterruptedPipelineRuns } from '../lib/tabStore/pipelineRun';
import {
  TypedMessageEnvelopeSchema,
  type ClaimResult,
  type TypedMessage,
  type UpdateRunResult,
} from '../lib/messages';
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

  // These three are the only messages on this channel with a real reply — see `lib/messages.ts`'s
  // `updateRun`/`startFill`/`startSaveApplication` for why a refusal has to reach the panel this
  // way. Chrome only keeps a channel open past this listener's return for a message this callback
  // claims with `true`, so this is the one branch that does not acknowledge synchronously below.
  if (
    message.type === 'UPDATE_RUN' ||
    message.type === 'START_FILL' ||
    message.type === 'START_SAVE_APPLICATION'
  ) {
    // Answering a channel the panel has already closed throws ("Attempting to use a disconnected
    // port"). That is a benign close, not a failure: swallowing it here keeps it out of the
    // `.catch` below, which would otherwise log a routing error for it and then call
    // `sendResponse` a second time — throwing again, inside the catch handler, with nothing left
    // downstream to catch it.
    const answer = (result: void | UpdateRunResult | ClaimResult) => {
      try {
        sendResponse(result);
      } catch {
        // The panel closed while the operation was in flight. Nobody is waiting for this answer.
      }
    };

    void recoveryReady
      .then(() => handleTypedMessage(message, sender))
      .then(answer)
      .catch((error: unknown) => {
        console.error('[djobi] background message failed', {
          type: message.type,
          tabId: tabIdOf(message, sender),
          ...('runId' in message ? { runId: message.runId } : {}),
          ...('expectedRunId' in message ? { expectedRunId: message.expectedRunId } : {}),
          error,
        });
        // No confirmed answer, so the caller treats this exactly like a refusal.
        answer(
          message.type === 'UPDATE_RUN' ? { applied: false } : { claimed: false, reason: 'busy' },
        );
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
