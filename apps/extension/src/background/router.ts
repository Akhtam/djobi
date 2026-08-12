import type { TypedMessage } from '../lib/messages';
import { enrichDetectedFields, reportDetectedPage } from '../lib/tabStore';
import { enrichWithApiOracle } from './apiDetectors';
import { runAnalysis, runFill } from './applicationPipeline';

/** Routes a typed content-script/panel coordination message, using `lib/tabStore.ts` as the hand-off point. */
export function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response: unknown) => void,
): boolean {
  switch (message.type) {
    case 'REPORT_JOB_PAGE': {
      const tabId = sender.tab?.id;
      // `frameId` is 0 for the main frame; the content script runs in every frame, so an ATS form
      // in an iframe and its host page are recorded separately rather than overwriting each other.
      const frameId = sender.frameId ?? 0;
      if (tabId === undefined) return false;

      const data = { fields: message.fields };
      const url = sender.tab?.url;

      void reportDetectedPage(tabId, frameId, data).then((reportedAt) => {
        if (!url) return;
        // Fire-and-forget: the DOM-only fields are already stored and usable above. This only
        // upgrades them (e.g. filling in a portal-mounted combobox's choices) once the platform API
        // answers — and `enrichDetectedFields` drops the result if this frame has been re-reported
        // in the meantime, so a slow response for a page we've navigated away from can't land on
        // top of fresher detection.
        void enrichWithApiOracle(url, message.fields).then((fields) =>
          enrichDetectedFields(tabId, frameId, reportedAt, fields),
        );
      });
      return false;
    }

    case 'START_ANALYSIS':
      // Fire-and-forget: `runAnalysis` checkpoints progress into `tabStore` itself, so the caller
      // doesn't need this message's response — and must not, since holding the channel open until
      // the whole Analysis Step resolves is exactly the failure mode (an in-flight call dying with
      // the panel that started it) this message type replaces.
      void runAnalysis(message.tabId, message.tabUrl, message.profile, message.jobDescription);
      return false;

    case 'START_FILL':
      void runFill(message.tabId, message.profile);
      return false;

    default:
      return false;
  }
}
