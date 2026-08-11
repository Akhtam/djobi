import type { TypedMessage } from '../lib/messages';
import { enrichWithApiOracle } from './apiDetectors';
import { getJobPageData, setJobPageData } from './jobPageStore';
import { runAnalysis, runFill } from './pipelineRunner';

/** Routes a typed content-script/panel coordination message, using `jobPageStore.ts` as the hand-off point. */
export function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  switch (message.type) {
    case 'REPORT_JOB_PAGE':
      if (sender.tab?.id !== undefined) {
        const tabId = sender.tab.id;
        const data = { pageText: message.pageText, fields: message.fields };
        setJobPageData(tabId, data);

        const url = sender.tab.url;
        if (url) {
          // Fire-and-forget: the DOM-only fields are already usable and stored above; this only
          // upgrades them (e.g. filling in a portal-mounted combobox's options) once the API
          // resolves, well before a user is likely to open the panel and read the store.
          void enrichWithApiOracle(url, message.fields).then((fields) => {
            setJobPageData(tabId, { ...data, fields });
          });
        }
      }
      return false;

    case 'GET_JOB_PAGE_DATA':
      sendResponse({ data: getJobPageData(message.tabId) });
      return false;

    case 'START_ANALYSIS':
      // Fire-and-forget: `runAnalysis` checkpoints progress into `pipelineRunStore` itself, so
      // the caller doesn't need this message's response — and must not, since holding the
      // channel open until the whole Analysis Step resolves is exactly the failure mode (an
      // in-flight call dying with the panel that started it) this message type replaces.
      void runAnalysis(message.tabId, message.tabUrl, message.profile, message.pageTextOverride);
      return false;

    case 'START_FILL':
      void runFill(message.tabId, message.profile);
      return false;

    default:
      return false;
  }
}
