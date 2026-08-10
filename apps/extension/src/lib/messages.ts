import type { DetectedField } from '@djobi/shared';

/** What the content script reports once it's detected and scraped an ATS job application page. */
export interface JobPageData {
  pageText: string;
  fields: DetectedField[];
}

/** Content script -> background: reports a detected job page. No response. */
export interface ReportJobPageMessage extends JobPageData {
  type: 'REPORT_JOB_PAGE';
}

/** Popup -> background: reads back the job page reported for a tab. Response: `{ data: JobPageData | null }`. */
export interface GetJobPageDataMessage {
  type: 'GET_JOB_PAGE_DATA';
  tabId: number;
}

export interface FillFormPayload {
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] };
}

/** Popup -> background: fill a specific tab's form. Response: `{ ok: boolean }`. */
export interface FillFormRequestMessage extends FillFormPayload {
  type: 'FILL_FORM';
  tabId: number;
}

/** Background -> content (relayed from a FillFormRequestMessage): fill this tab's form. Response: `{ ok: boolean }`. */
export interface FillFormCommandMessage extends FillFormPayload {
  type: 'FILL_FORM';
}

export type TypedMessage = ReportJobPageMessage | GetJobPageDataMessage | FillFormRequestMessage;

/** Sends `message` via `chrome.runtime.sendMessage` and resolves with whatever the callback receives. */
export function sendMessage<TReq, TRes>(message: TReq): Promise<TRes> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}
