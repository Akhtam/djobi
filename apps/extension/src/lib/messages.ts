import type { DetectedField, Profile } from '@djobi/shared';

/** What the content script reports once it's detected and scraped an ATS job application page. */
export interface JobPageData {
  pageText: string;
  fields: DetectedField[];
}

/** Content script -> background: reports a detected job page. No response. */
export interface ReportJobPageMessage extends JobPageData {
  type: 'REPORT_JOB_PAGE';
}

/**
 * Panel -> background: start the Analysis Step for `tabId` (`background/pipelineRunner.ts` runs
 * it), so it keeps running even if the panel that requested it closes before it finishes. No
 * response payload — progress is observed via `lib/tabStore.ts` + `chrome.storage.onChanged`,
 * not the message response, precisely so the caller doesn't need to stay around to receive one.
 */
export interface StartAnalysisMessage {
  type: 'START_ANALYSIS';
  tabId: number;
  tabUrl: string | null;
  profile: Profile;
  pageTextOverride: string | null;
}

/** Panel -> background: start the Fill Step for `tabId`, reading Analysis Step results back out of `tabStore`. */
export interface StartFillMessage {
  type: 'START_FILL';
  tabId: number;
  profile: Profile;
}

export interface FillFormPayload {
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] };
}

/** Background -> content, sent directly by `pipelineRunner.ts` (not relayed via `TypedMessage`): fill this tab's form. Response: `{ ok: boolean }`. */
export interface FillFormCommandMessage extends FillFormPayload {
  type: 'FILL_FORM';
}

export type TypedMessage = ReportJobPageMessage | StartAnalysisMessage | StartFillMessage;

/** Sends `message` via `chrome.runtime.sendMessage` and resolves with whatever the callback receives. */
export function sendMessage<TReq, TRes>(message: TReq): Promise<TRes> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}
