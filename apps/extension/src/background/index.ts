/**
 * MV3 background service worker (`manifest.ts` → `background.service_worker`). Handles two kinds
 * of `chrome.runtime.onMessage` traffic:
 *
 * - The legacy, untyped `{ path, body, method? }` shape: relays to `callBackend.ts`, responding
 *   with `{ data }` on success or `{ error }` on failure. Used by the popup/options pages to talk
 *   to the local djobi backend.
 * - Typed messages (a `type` discriminator), for content-script/popup coordination — see
 *   `jobPageStore.ts` and each `case` below.
 */
import type { DetectedField } from '@djobi/shared';
import { callBackend } from './callBackend';
import { getJobPageData, setJobPageData } from './jobPageStore';

interface RelayMessage {
  path: string;
  body: unknown;
  method?: 'GET' | 'POST';
}

interface ReportJobPageMessage {
  type: 'REPORT_JOB_PAGE';
  pageText: string;
  fields: DetectedField[];
}

interface GetJobPageDataMessage {
  type: 'GET_JOB_PAGE_DATA';
  tabId: number;
}

interface FillFormMessage {
  type: 'FILL_FORM';
  tabId: number;
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] };
}

type TypedMessage = ReportJobPageMessage | GetJobPageDataMessage | FillFormMessage;

chrome.runtime.onMessage.addListener(
  (
    message: RelayMessage | TypedMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (!('type' in message)) {
      callBackend(message.path, message.body, message.method)
        .then((data) => sendResponse({ data }))
        .catch((error: Error) => sendResponse({ error: error.message }));
      return true;
    }

    switch (message.type) {
      case 'REPORT_JOB_PAGE':
        if (sender.tab?.id !== undefined) {
          setJobPageData(sender.tab.id, { pageText: message.pageText, fields: message.fields });
        }
        return false;

      case 'GET_JOB_PAGE_DATA':
        sendResponse({ data: getJobPageData(message.tabId) });
        return false;

      case 'FILL_FORM':
        chrome.tabs.sendMessage(
          message.tabId,
          {
            type: 'FILL_FORM',
            fields: message.fields,
            values: message.values,
            resumeFile: message.resumeFile,
          },
          (response) => sendResponse(response),
        );
        return true;

      default:
        return false;
    }
  },
);
