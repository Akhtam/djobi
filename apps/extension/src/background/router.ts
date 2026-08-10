import type { FillFormCommandMessage, TypedMessage } from '../lib/messages';
import { getJobPageData, setJobPageData } from './jobPageStore';

/** Routes a typed content-script/popup coordination message, using `jobPageStore.ts` as the hand-off point. */
export function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  switch (message.type) {
    case 'REPORT_JOB_PAGE':
      if (sender.tab?.id !== undefined) {
        setJobPageData(sender.tab.id, { pageText: message.pageText, fields: message.fields });
      }
      return false;

    case 'GET_JOB_PAGE_DATA':
      sendResponse({ data: getJobPageData(message.tabId) });
      return false;

    case 'FILL_FORM': {
      const command: FillFormCommandMessage = {
        type: 'FILL_FORM',
        fields: message.fields,
        values: message.values,
        resumeFile: message.resumeFile,
      };
      chrome.tabs.sendMessage(message.tabId, command, (response) => sendResponse(response));
      return true;
    }

    default:
      return false;
  }
}
