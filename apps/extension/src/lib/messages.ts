import type { DetectedField, Profile, QuestionAnswer } from '@djobi/shared';

/**
 * What the content script reports once it's detected an ATS job application form: the fields it
 * found, and nothing else.
 *
 * It used to carry a `pageText` scrape of the page alongside them, which was the Analysis Step's
 * input. That never worked reliably enough to keep: an ATS application form is a different page
 * from the posting, so the scrape routinely captured the form's own labels, a cookie banner and a
 * nav bar instead of the job description — and on a client-rendered ATS it captured whatever
 * happened to have mounted. The job description now comes from the candidate pasting it
 * ({@link StartAnalysisMessage.jobDescription}), which is the one source that is always the actual
 * posting. Detection remains, because the Fill Step still needs to know what to fill.
 */
export interface JobPageData {
  fields: DetectedField[];
}

/** Content script -> background: reports a detected job page. No response. */
export interface ReportJobPageMessage extends JobPageData {
  type: 'REPORT_JOB_PAGE';
}

/**
 * Panel -> background: start the Analysis Step for `tabId` (`background/applicationPipeline.ts` runs
 * it), so it keeps running even if the panel that requested it closes before it finishes. No
 * response payload — progress is observed via `lib/tabStore.ts` + `chrome.storage.onChanged`,
 * not the message response, precisely so the caller doesn't need to stay around to receive one.
 */
export interface StartAnalysisMessage {
  type: 'START_ANALYSIS';
  tabId: number;
  tabUrl: string | null;
  profile: Profile;
  /** The posting the candidate pasted into the panel — the Analysis Step's only input. */
  jobDescription: string;
  /**
   * Skip the duplicate check and analyze regardless. Set only when the candidate chose "Analyze and
   * apply anyway" after being told they already applied to this URL.
   */
  force?: boolean;
}

/** Panel -> background: start the Fill Step for `tabId`, reading Analysis Step results back out of `tabStore`. */
export interface StartFillMessage {
  type: 'START_FILL';
  tabId: number;
  profile: Profile;
}

/** Panel -> background: persist the current filled application snapshot. */
export interface StartSaveApplicationMessage {
  type: 'START_SAVE_APPLICATION';
  tabId: number;
}

/** Panel -> background: persist optimistic review edits against the run they were made on. */
export interface UpdateRunMessage {
  type: 'UPDATE_RUN';
  tabId: number;
  runId: string;
  updates: {
    answers: QuestionAnswer[];
    jobDescription: string;
    /** Editing a saved snapshot makes it pending until it is saved again. */
    status?: 'filled';
  };
}

export interface FillFormPayload {
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] };
}

/**
 * What the content script reports back about a fill it just performed — the ids of the fields
 * whose value was verifiably still on the page afterwards, and whether the resume was attached.
 *
 * The Fill Step used to derive "what got filled" from the values it *sent*, which can only ever
 * describe intent. Nothing crossing back from the page meant a fill that wrote to a stale
 * selector, or into a React field that discarded it, was indistinguishable from a perfect run, and
 * the panel showed a green check over a form the ATS then rejected as empty. This is the page's
 * own account of what happened; see `content/fillForm.ts` for how it's established.
 */
export interface FillFormResult {
  ok: boolean;
  filledFieldIds: string[];
  resumeAttached: boolean;
}

/** Background -> content, sent directly by `applicationPipeline.ts` (not relayed via `TypedMessage`): fill this tab's form. Response: {@link FillFormResult}. */
export interface FillFormCommandMessage extends FillFormPayload {
  type: 'FILL_FORM';
}

/**
 * Background -> content: re-scan the page right now and answer with what's currently there.
 * Response: {@link JobPageData}, or no response at all from a frame holding no form.
 *
 * The Fill Step asks for this instead of filling from the detection captured when the Analysis Step
 * started. Those can be minutes apart — long enough for the candidate to have expanded a section,
 * for the ATS to have mounted a conditional question, or for the whole form to have arrived after
 * the analysis ran on a pasted job description — and filling from the stale copy writes to fields
 * that may no longer exist while leaving the ones that do exist empty.
 *
 * Only frames that currently hold a form reply, so the response comes from the frame with the form
 * rather than from whichever frame `chrome.tabs.sendMessage` happens to reach first.
 */
export interface ScanPageCommandMessage {
  type: 'SCAN_PAGE';
}

/** Everything the background sends *to* a content script. See `lib/pageClient.ts`. */
export type ContentCommandMessage = FillFormCommandMessage | ScanPageCommandMessage;

/**
 * The coordination protocol: content script and panel telling the background that something
 * happened. **Notification-only — none of these has a response.**
 *
 * That's a real design decision, not an omission. Reports and edits have nothing to return, while
 * START messages kick off work whose whole point is outliving the sender. Holding the message
 * channel open until an Analysis Step resolves is exactly the failure this protocol was built to
 * avoid, since the channel dies with the panel that opened it. Progress is read from
 * `lib/tabStore.ts` instead.
 *
 * The two messages that *do* have responses (`SCAN_PAGE`, `FILL_FORM`) are not in this union. They
 * live in `lib/pageClient.ts`, where the response is the point.
 *
 * This used to be typed as request/response on both ends — a `sendMessage<TReq, TRes>` generic over
 * a response nothing ever sent, and a handler taking `sendResponse` it never called and returning a
 * `boolean` that was always `false`. Every caller wrote `<…, void>` and discarded the promise. An
 * interface that describes capabilities the implementation doesn't have is worse than no types.
 */
export type TypedMessage =
  | ReportJobPageMessage
  | StartAnalysisMessage
  | StartFillMessage
  | StartSaveApplicationMessage
  | UpdateRunMessage;

/**
 * Sends a coordination message to the background and returns immediately. There is no reply to
 * wait for.
 *
 * The callback exists only so `chrome.runtime.lastError` is read, which is what marks it handled —
 * without it, sending while no service worker is listening logs an unchecked runtime error.
 */
export function notify(message: TypedMessage): void {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}
