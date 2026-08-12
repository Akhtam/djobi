import { parseDetectedFields } from '@djobi/shared';
import type { TypedMessage } from '../lib/messages';
import { enrichDetectedFields, reportDetectedPage } from '../lib/tabStore';
import { enrichWithApiOracle } from './apiDetectors';
import { runAnalysis, runFill } from './applicationPipeline';

/**
 * Routes a coordination message, using `lib/tabStore.ts` as the hand-off point.
 *
 * Returns nothing, and takes no `sendResponse`: {@link TypedMessage} is notification-only, and the
 * sender is not waiting. Every branch here is fire-and-forget by design — see the note on
 * `TypedMessage` for why holding the channel open is the failure mode rather than the feature.
 *
 * What this module genuinely owns, and the reason it isn't just inlined into the service worker, is
 * the frame/revision rule below.
 */
export function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
): void {
  switch (message.type) {
    case 'REPORT_JOB_PAGE': {
      const tabId = sender.tab?.id;
      // `frameId` is 0 for the main frame; the content script runs in every frame, so an ATS form
      // in an iframe and its host page are recorded separately rather than overwriting each other.
      const frameId = sender.frameId ?? 0;
      if (tabId === undefined) return;

      // Parsed, not trusted. A content script keeps running against the build that injected it, so
      // after an extension reload a tab left open reports the field shape *that* build produced.
      // `content/index.ts` already handles the send side of this case; this is the receive side.
      const fields = parseDetectedFields(message.fields);
      const data = { fields };
      const url = sender.tab?.url;

      void reportDetectedPage(tabId, frameId, data).then((reportedAt) => {
        if (!url) return;
        // Fire-and-forget: the DOM-only fields are already stored and usable above. This only
        // upgrades them (e.g. filling in a portal-mounted combobox's choices) once the platform API
        // answers — and `enrichDetectedFields` drops the result if this frame has been re-reported
        // in the meantime, so a slow response for a page we've navigated away from can't land on
        // top of fresher detection.
        void enrichWithApiOracle(url, fields).then((enriched) =>
          enrichDetectedFields(tabId, frameId, reportedAt, enriched),
        );
      });
      return;
    }

    case 'START_ANALYSIS':
      // `runAnalysis` checkpoints progress into `tabStore` itself, so the panel reads results from
      // there rather than from a reply it would have to stay open to receive.
      void runAnalysis(message.tabId, message.tabUrl, message.profile, message.jobDescription);
      return;

    case 'START_FILL':
      void runFill(message.tabId, message.profile);
      return;
  }
}
