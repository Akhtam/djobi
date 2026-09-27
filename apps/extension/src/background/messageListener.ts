import {
  TypedMessageEnvelopeSchema,
  type ClaimResult,
  type TypedMessage,
  type UpdateRunResult,
} from '../lib/messages';

type Reply = void | UpdateRunResult | ClaimResult;

/** Routes one parsed coordination message — `background/router.ts`'s `handleTypedMessage`. */
export type RouteTypedMessage = (
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
) => Promise<Reply>;

/**
 * The background's `chrome.runtime.onMessage` listener — the one copy of the reply rules, used by
 * `service-worker.ts` and by `panel/panelTestHarness.ts`.
 *
 * Most messages get an immediate empty acknowledgement and are routed fire-and-forget.
 * `UPDATE_RUN`, `START_FILL` and `START_SAVE_APPLICATION` hold the channel open for the route's
 * answer, because a refusal produces no storage change for the panel to observe; the Fill/Save
 * reply covers only the claim — the step keeps running.
 *
 * Every route waits on `ready` (the service worker's recovery sweep). The `.catch` here is the one
 * place a routed task's terminal rejection is logged.
 */
export function typedMessageListener(route: RouteTypedMessage, ready: Promise<void>) {
  return (
    input: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: Reply) => void,
  ): true | undefined => {
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
    const refusal = refusalOf(message);

    if (refusal) {
      // Replying on a channel the panel already closed throws; that's benign, so swallow it here
      // rather than log it and reply a second time from the `.catch`.
      const answer = (result: Reply) => {
        try {
          sendResponse(result);
        } catch {
          // The panel closed while the operation was in flight. Nobody is waiting for this answer.
        }
      };

      void ready
        .then(() => route(message, sender))
        .then(answer)
        .catch((error: unknown) => {
          logFailure(message, sender, error);
          // No confirmed answer, so the caller treats this exactly like a refusal.
          answer(refusal);
        });
      // Chrome only keeps a channel open past this listener's return for a message claimed with
      // `true`.
      return true;
    }

    // Acknowledge synchronously with no payload; the routed task is fire-and-forget and outlives
    // the panel.
    sendResponse();
    void ready
      .then(() => route(message, sender))
      .catch((error: unknown) => logFailure(message, sender, error));
    return;
  };
}

/** What a message with a real reply answers when its route fails; `null` for a notification. */
function refusalOf(message: TypedMessage): UpdateRunResult | ClaimResult | null {
  switch (message.type) {
    case 'UPDATE_RUN':
      return { applied: false };
    case 'START_FILL':
    case 'START_SAVE_APPLICATION':
      return { claimed: false, reason: 'busy' };
    default:
      return null;
  }
}

function logFailure(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  error: unknown,
): void {
  console.error('[djobi] background message failed', {
    type: message.type,
    tabId: 'tabId' in message ? message.tabId : sender.tab?.id,
    ...('runId' in message ? { runId: message.runId } : {}),
    ...('expectedRunId' in message ? { expectedRunId: message.expectedRunId } : {}),
    error,
  });
}
