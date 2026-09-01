import {
  DetectedFieldSchema,
  ProfileSchema,
  QuestionAnswerSchema,
  TailoredResumeSchema,
  z,
  type DetectedField,
  type ZodTypeOf,
} from '@djobi/shared';
import { JobDescriptionSourceSchema } from './jobContext';

/**
 * What the content script reports once it's detected an ATS job application form: the fields it
 * found, and nothing else.
 *
 * It used to carry an unconditional `pageText` dump alongside form detection. That routinely sent
 * form labels, cookie banners and navigation into Analysis. Posting extraction is now a separate,
 * explicit `SCRAPE_JOB_DESCRIPTION` request that fails closed and only populates the candidate's
 * editable field. Detection remains independent because the Fill Step needs to know what to fill.
 */
export const JobPageDataSchema = z.object({ fields: z.array(DetectedFieldSchema) }).strict();
export type JobPageData = ZodTypeOf<typeof JobPageDataSchema>;

/** Content script -> background: reports a detected job page. No response. */
export const ReportJobPageMessageSchema = JobPageDataSchema.extend({
  type: z.literal('REPORT_JOB_PAGE'),
}).strict();
export type ReportJobPageMessage = ZodTypeOf<typeof ReportJobPageMessageSchema>;

/**
 * Panel -> background: start the Analysis Step for `tabId` (`background/applicationPipeline.ts` runs
 * it), so it keeps running even if the panel that requested it closes before it finishes. No
 * response payload — progress is observed via `lib/tabStore/pipelineRun.ts` +
 * `chrome.storage.onChanged`, not the message response, precisely so the caller doesn't need to
 * stay around to receive one.
 */
export const StartAnalysisMessageSchema = z
  .object({
    type: z.literal('START_ANALYSIS'),
    tabId: z.number().int().nonnegative(),
    tabUrl: z.string().nullable(),
    profile: ProfileSchema,
    /** The candidate-reviewed posting text from the panel — the Analysis Step's only input. */
    jobDescription: z.string(),
    /** Skip the duplicate check after the candidate chose "Analyze and apply anyway". */
    force: z.boolean().optional(),
  })
  .strict();
export type StartAnalysisMessage = ZodTypeOf<typeof StartAnalysisMessageSchema>;

/**
 * Panel -> background: start the Fill Step for `tabId`, reading Analysis Step results back out of
 * `tabStore/pipelineRun.ts`.
 *
 * `expectedRunId` names the run the panel meant. Delivery is not instantaneous and the panel can
 * only ever name the run it was rendering, so a command delayed past a re-analysis would otherwise
 * claim whichever run is current when it lands — filling a different posting's form from a
 * different posting's answers. {@link UpdateRunMessage} has always carried its `runId`; these two
 * were the exception. See `background/runClaim.ts`.
 */
export const StartFillMessageSchema = z
  .object({
    type: z.literal('START_FILL'),
    tabId: z.number().int().nonnegative(),
    profile: ProfileSchema,
    expectedRunId: z.string(),
  })
  .strict();
export type StartFillMessage = ZodTypeOf<typeof StartFillMessageSchema>;

/** Panel -> background: persist the current filled application snapshot. */
export const StartSaveApplicationMessageSchema = z
  .object({
    type: z.literal('START_SAVE_APPLICATION'),
    tabId: z.number().int().nonnegative(),
    /** The run the panel meant — see {@link StartFillMessage.expectedRunId}. */
    expectedRunId: z.string(),
  })
  .strict();
export type StartSaveApplicationMessage = ZodTypeOf<typeof StartSaveApplicationMessageSchema>;

/** Panel -> background: persist optimistic review edits against the run they were made on. */
export const UpdateRunMessageSchema = z
  .object({
    type: z.literal('UPDATE_RUN'),
    tabId: z.number().int().nonnegative(),
    runId: z.string(),
    updates: z
      .object({
        answers: z.array(QuestionAnswerSchema),
        jobDescription: z.string(),
        /** The candidate's own accept/reject/reorder/edit changes to the Analysis Step's output —
         * see `panel/ResumeReview.tsx`. Optional: an answers/jobDescription-only edit sends nothing
         * here, and the background leaves the stored resume untouched rather than overwriting it
         * with `undefined`. */
        tailoredResume: TailoredResumeSchema.optional(),
        /** Editing a saved snapshot makes it pending until it is saved again. */
        status: z.literal('filled').optional(),
      })
      .strict(),
  })
  .strict();
export type UpdateRunMessage = ZodTypeOf<typeof UpdateRunMessageSchema>;

/** Panel -> background: retain the editable pre-analysis description for this job. */
export const UpdateJobContextMessageSchema = z
  .object({
    type: z.literal('UPDATE_JOB_CONTEXT'),
    tabId: z.number().int().nonnegative(),
    tabUrl: z.string(),
    jobDescription: z.string(),
    source: JobDescriptionSourceSchema,
  })
  .strict();
export type UpdateJobContextMessage = ZodTypeOf<typeof UpdateJobContextMessageSchema>;

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
export const FillFormResultSchema = z
  .object({
    ok: z.literal(true),
    filledFieldIds: z.array(z.string()),
    resumeAttached: z.boolean(),
  })
  .strict();
export type FillFormResult = ZodTypeOf<typeof FillFormResultSchema>;

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

/** A focused posting candidate extracted from one frame. */
export interface ScrapedJobDescription {
  text: string;
  /** Comparable within this extractor; the frame reader uses it to select the best candidate. */
  score: number;
  source: 'structured-data' | 'dom';
}

/** Panel -> content: find the Job Description visible in this frame. */
export interface ScrapeJobDescriptionCommandMessage {
  type: 'SCRAPE_JOB_DESCRIPTION';
}

/** An explicit reply lets the caller distinguish "no posting here" from an unreachable frame. */
export interface ScrapeJobDescriptionResponse {
  candidate: ScrapedJobDescription | null;
}

/** Everything the background sends *to* a content script. See `lib/pageClient.ts`. */
export type ContentCommandMessage =
  FillFormCommandMessage | ScanPageCommandMessage | ScrapeJobDescriptionCommandMessage;

/**
 * The coordination protocol: content script and panel telling the background that something
 * happened. **Notification-only — none of these has an operation response.**
 *
 * That's a real design decision, not an omission. Reports and edits have nothing to return, while
 * START messages kick off work whose whole point is outliving the sender. The service worker sends
 * only an immediate empty receipt acknowledgement; holding the channel open until an Analysis Step
 * resolves is exactly the failure this protocol was built to avoid, since the channel dies with the
 * panel that opened it. Progress is read from `lib/tabStore/pipelineRun.ts` instead.
 *
 * The messages that *do* have responses are not in this union: `SCAN_PAGE` and `FILL_FORM` live in
 * `lib/pageClient.ts`, while `SCRAPE_JOB_DESCRIPTION` lives in `lib/postingReader.ts`.
 *
 * This used to be typed as request/response on both ends — a `sendMessage<TReq, TRes>` generic over
 * a response nothing ever sent, and a handler taking `sendResponse` it never called and returning a
 * `boolean` that was always `false`. Every caller wrote `<…, void>` and discarded the promise. An
 * interface that describes capabilities the implementation doesn't have is worse than no types.
 */
/**
 * Panel -> background: the panel is watching a step that claims to still be running. No response.
 *
 * It carries no work of its own and its handler does nothing. **Waking a worker is the entire
 * point.** A step's progress is only ever repaired by a worker starting — `service-worker.ts` runs
 * `recoverInterruptedPipelineRuns` before it routes anything — and a panel sitting on `analyzing`
 * sends nothing that would start one. So the run that Chrome stopped mid-step stays `analyzing`
 * forever, with no error and no retry, which is the exact state the recovery sweep exists to clear.
 *
 * Harmless when the worker is alive and genuinely working: the sweep has already run for that
 * instance, so this routes to a no-op and the real step keeps going.
 */
export const CheckRunMessageSchema = z
  .object({ type: z.literal('CHECK_RUN'), tabId: z.number().int().nonnegative() })
  .strict();
export type CheckRunMessage = ZodTypeOf<typeof CheckRunMessageSchema>;

export const TypedMessageSchema = z.discriminatedUnion('type', [
  ReportJobPageMessageSchema,
  StartAnalysisMessageSchema,
  StartFillMessageSchema,
  StartSaveApplicationMessageSchema,
  UpdateRunMessageSchema,
  UpdateJobContextMessageSchema,
  CheckRunMessageSchema,
]);
export type TypedMessage = ZodTypeOf<typeof TypedMessageSchema>;

/** Independent of the manifest version: bump only when this coordination protocol is incompatible. */
export const TYPED_MESSAGE_PROTOCOL = 'djobi/typed-message' as const;
export const TYPED_MESSAGE_VERSION = 1 as const;

export const TypedMessageEnvelopeSchema = z
  .object({
    protocol: z.literal(TYPED_MESSAGE_PROTOCOL),
    version: z.literal(TYPED_MESSAGE_VERSION),
    payload: TypedMessageSchema,
  })
  .strict();
export type TypedMessageEnvelope = ZodTypeOf<typeof TypedMessageEnvelopeSchema>;

export function typedMessageEnvelope(message: TypedMessage): TypedMessageEnvelope {
  return {
    protocol: TYPED_MESSAGE_PROTOCOL,
    version: TYPED_MESSAGE_VERSION,
    payload: message,
  };
}

/**
 * Sends a coordination message to the background and returns immediately. There is no operation
 * result to wait for; the callback receives only the service worker's empty receipt acknowledgement.
 *
 * The callback reads `chrome.runtime.lastError`, which marks it handled. A START caller may also
 * use `onDispatchError` to stand down optimistic UI when Chrome could not deliver the notification;
 * this still adds no response payload and does not wait for the operation.
 */
export function notify(message: TypedMessage, onDispatchError?: (message: string) => void): void {
  chrome.runtime.sendMessage(typedMessageEnvelope(message), () => {
    const error = chrome.runtime.lastError;
    if (error)
      onDispatchError?.(error.message || 'The background worker did not receive the command.');
  });
}
