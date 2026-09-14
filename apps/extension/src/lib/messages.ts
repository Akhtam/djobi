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
export const JobPageDataSchema = z.strictObject({ fields: z.array(DetectedFieldSchema) });
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
export const StartAnalysisMessageSchema = z.strictObject({
  type: z.literal('START_ANALYSIS'),
  tabId: z.number().int().nonnegative(),
  tabUrl: z.string().nullable(),
  profile: ProfileSchema,
  /** The candidate-reviewed posting text from the panel — the Analysis Step's only input. */
  jobDescription: z.string(),
  /** Skip the duplicate check after the candidate chose "Analyze and apply anyway". */
  force: z.boolean().optional(),
});
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
export const StartFillMessageSchema = z.strictObject({
  type: z.literal('START_FILL'),
  tabId: z.number().int().nonnegative(),
  profile: ProfileSchema,
  expectedRunId: z.string(),
});
export type StartFillMessage = ZodTypeOf<typeof StartFillMessageSchema>;

/** Panel -> background: persist the current filled application snapshot. */
export const StartSaveApplicationMessageSchema = z.strictObject({
  type: z.literal('START_SAVE_APPLICATION'),
  tabId: z.number().int().nonnegative(),
  /** The run the panel meant — see {@link StartFillMessage.expectedRunId}. */
  expectedRunId: z.string(),
});
export type StartSaveApplicationMessage = ZodTypeOf<typeof StartSaveApplicationMessageSchema>;

/** Panel -> background: persist optimistic review edits against the run they were made on. */
export const UpdateRunMessageSchema = z
  .object({
    type: z.literal('UPDATE_RUN'),
    tabId: z.number().int().nonnegative(),
    runId: z.string(),
    updates: z.strictObject({
      answers: z.array(QuestionAnswerSchema),
      jobDescription: z.string(),
      /** The candidate's own accept/reject/reorder/edit changes to the Analysis Step's output —
       * see `panel/ResumeReview.tsx`. Optional: an answers/jobDescription-only edit sends nothing
       * here, and the background leaves the stored resume untouched rather than overwriting it
       * with `undefined`. */
      tailoredResume: TailoredResumeSchema.optional(),
    }),
    // No `status` field: whether a saved run reverts to `filled` is the run domain's call, not the
    // panel's — `lib/tabStore/pipelineRun.ts`'s `applyPanelEdit` derives it from what actually
    // changed. A panel-supplied literal was applied unconditionally, so a no-op resend (an undo, or
    // a duplicate send) demoted a `saved` run for no real change.
  })
  .strict();
export type UpdateRunMessage = ZodTypeOf<typeof UpdateRunMessageSchema>;

/** Background -> panel: whether an `UPDATE_RUN` edit was actually written. */
export const UpdateRunResultSchema = z.strictObject({ applied: z.boolean() });
export type UpdateRunResult = ZodTypeOf<typeof UpdateRunResultSchema>;

/**
 * Background -> panel: whether a `START_FILL`/`START_SAVE_APPLICATION` actually claimed the run,
 * replied the moment `background/runClaim.ts` knows — before the step itself has run, let alone
 * finished.
 *
 * `'busy'` means another step is already claiming this run (a second panel, most often — a single
 * panel's own buttons are disabled while its own command is in flight). `'stale-run'` means the
 * command named a run that is no longer the tab's current one, e.g. a re-analysis landed between
 * the panel rendering and this command arriving. Both stand the caller's optimistic status down the
 * same way a delivery failure already does — see `panel/pipelineCommands.ts`.
 */
export const ClaimResultSchema = z.discriminatedUnion('claimed', [
  z.strictObject({ claimed: z.literal(true) }),
  z.strictObject({ claimed: z.literal(false), reason: z.enum(['busy', 'stale-run']) }),
]);
export type ClaimResult = ZodTypeOf<typeof ClaimResultSchema>;

/**
 * What {@link updateRun} learned about one edit. `delivered` separates "the store answered, and
 * said no" from "nothing answered at all" — a worker restarting, an extension reload, a listener
 * not yet registered, or a reply this build cannot parse. Both leave nothing written, but only the
 * first is a decision about the edit: an undelivered edit is retryable, and the caller should keep
 * its optimistic copy rather than throw the user's typing away on a transient channel failure.
 */
export type UpdateRunOutcome = UpdateRunResult & { delivered: boolean };

/** Panel -> background: retain the editable pre-analysis description for this job. */
export const UpdateJobContextMessageSchema = z.strictObject({
  type: z.literal('UPDATE_JOB_CONTEXT'),
  tabId: z.number().int().nonnegative(),
  tabUrl: z.string(),
  jobDescription: z.string(),
  source: JobDescriptionSourceSchema,
});
export type UpdateJobContextMessage = ZodTypeOf<typeof UpdateJobContextMessageSchema>;

export interface FillFormPayload {
  /**
   * The run this fill belongs to. The page keeps it so that a submission it observes afterwards can
   * name the run it is a submission *of* — see {@link ReportSubmissionMessageSchema}.
   */
  runId: string;
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] } | undefined;
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
export const FillFormResultSchema = z.strictObject({
  ok: z.literal(true),
  filledFieldIds: z.array(z.string()),
  resumeAttached: z.boolean(),
});
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
export const ScrapedJobDescriptionSchema = z.strictObject({
  text: z.string(),
  /** Comparable within this extractor; the frame reader uses it to select the best candidate. */
  score: z.number(),
  source: z.enum(['structured-data', 'dom']),
});
export type ScrapedJobDescription = ZodTypeOf<typeof ScrapedJobDescriptionSchema>;

/** Panel -> content: find the Job Description visible in this frame. */
export interface ScrapeJobDescriptionCommandMessage {
  type: 'SCRAPE_JOB_DESCRIPTION';
}

/** An explicit reply lets the caller distinguish "no posting here" from an unreachable frame. */
export const ScrapeJobDescriptionResponseSchema = z.strictObject({
  candidate: ScrapedJobDescriptionSchema.nullable(),
});
export type ScrapeJobDescriptionResponse = ZodTypeOf<typeof ScrapeJobDescriptionResponseSchema>;

/**
 * Background -> content: tell the candidate, on the page itself, that their application was
 * recorded. No response.
 *
 * The side panel is usually closed by the time an auto-save lands, and the submit that triggered it
 * usually navigates the tab, so the panel's own `saved` status is not on screen for anyone to read.
 * This is best-effort for exactly that reason — a frame already torn down by the navigation simply
 * never receives it, and `background/saveBadge.ts` is the confirmation that survives.
 */
export interface ShowSavedToastCommandMessage {
  type: 'SHOW_SAVED_TOAST';
  company: string;
  roleTitle: string;
}

/** Everything the background sends *to* a content script. See `lib/pageClient.ts`. */
export type ContentCommandMessage =
  | FillFormCommandMessage
  | ScanPageCommandMessage
  | ScrapeJobDescriptionCommandMessage
  | ShowSavedToastCommandMessage;

/**
 * The coordination protocol: content script and panel telling the background that something
 * happened. **Notification-only by default — most of these have no operation response.**
 *
 * That's a real design decision, not an omission. Reports have nothing to return, and starting a
 * step kicks off work whose whole point is outliving the sender: the service worker sends only an
 * immediate empty receipt acknowledgement, and holding the channel open until an Analysis Step
 * resolves is exactly the failure this protocol was built to avoid, since the channel dies with the
 * panel that opened it. Progress is read from `lib/tabStore/pipelineRun.ts` instead.
 *
 * Three messages are the documented exception, each for the same reason: a refusal produces no
 * `chrome.storage.onChanged` event for the caller to learn it from, so it has to be a real answer
 * instead. `UPDATE_RUN` answers whether the store actually wrote the edit ({@link UpdateRunResult}).
 * `START_FILL`/`START_SAVE_APPLICATION` answer whether the claim was won ({@link ClaimResult}) —
 * before the step itself runs, let alone finishes; that part stays notification-shaped. Every other
 * message here still has none.
 *
 * The messages that *do* have responses are not otherwise in this union: `SCAN_PAGE`, `FILL_FORM`,
 * and `SCRAPE_JOB_DESCRIPTION` live in `lib/pageClient.ts`.
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
/**
 * Content script -> background: the candidate just submitted a form this extension had filled. No
 * response.
 *
 * `runId` names the run the fill was performed for, and is the same defence `background/runClaim.ts`
 * documents for `START_FILL`/`START_SAVE_APPLICATION`: a submission reported after the tab has moved
 * on to another posting must not save *that* posting's run. The content script only ever arms its
 * watcher from a `FILL_FORM` it completed, so this can only be sent for a run the extension filled.
 */
export const ReportSubmissionMessageSchema = z.strictObject({
  type: z.literal('REPORT_SUBMISSION'),
  runId: z.string().min(1),
});
export type ReportSubmissionMessage = ZodTypeOf<typeof ReportSubmissionMessageSchema>;

export const CheckRunMessageSchema = z.strictObject({
  type: z.literal('CHECK_RUN'),
  tabId: z.number().int().nonnegative(),
});
export type CheckRunMessage = ZodTypeOf<typeof CheckRunMessageSchema>;

export const TypedMessageSchema = z.discriminatedUnion('type', [
  ReportJobPageMessageSchema,
  StartAnalysisMessageSchema,
  StartFillMessageSchema,
  StartSaveApplicationMessageSchema,
  UpdateRunMessageSchema,
  UpdateJobContextMessageSchema,
  CheckRunMessageSchema,
  ReportSubmissionMessageSchema,
]);
export type TypedMessage = ZodTypeOf<typeof TypedMessageSchema>;

/** Independent of the manifest version: bump only when this coordination protocol is incompatible. */
export const TYPED_MESSAGE_PROTOCOL = 'djobi/typed-message' as const;
export const TYPED_MESSAGE_VERSION = 1 as const;

export const TypedMessageEnvelopeSchema = z.strictObject({
  protocol: z.literal(TYPED_MESSAGE_PROTOCOL),
  version: z.literal(TYPED_MESSAGE_VERSION),
  payload: TypedMessageSchema,
});
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

/**
 * Sends `UPDATE_RUN` and waits for the store's answer to it — the one panel -> background message
 * on a real request/response, the way `lib/pageClient.ts`'s messages are for the background ->
 * content-script direction.
 *
 * Every other coordination message here is `notify`'s fire-and-forget: those operations are
 * long-running and observed through `chrome.storage.onChanged` instead, which is what lets a panel
 * close mid-operation without losing anything. An edit is neither. It is one fast store write, and
 * the run domain can refuse it outright — a save in flight locks the snapshot it is writing, see
 * `lib/run/status.ts`'s `editable` — with no write to observe when it does. Without an answer,
 * `panel/usePipelineRun.ts` has no way to learn a queued edit was never applied, and keeps
 * preferring its own copy of it over the store's forever.
 *
 * Undelivered (no listener yet, e.g. the worker restarting) and a reply this build can't parse are
 * both `applied: false`: nothing is known to have been written, so the caller should not keep
 * waiting for a storage echo that this file cannot promise is coming. They carry `delivered: false`
 * to mark them apart from the store's own refusal — see {@link UpdateRunOutcome}.
 */
export function updateRun(message: UpdateRunMessage): Promise<UpdateRunOutcome> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(typedMessageEnvelope(message), (response: unknown) => {
      const error = chrome.runtime.lastError;
      const parsed = UpdateRunResultSchema.safeParse(response);
      resolve(
        error || !parsed.success
          ? { applied: false, delivered: false }
          : { ...parsed.data, delivered: true },
      );
    });
  });
}

/**
 * What {@link startFill}/{@link startSaveApplication} learned about a claim attempt. `delivered`
 * carries the same meaning {@link UpdateRunOutcome}'s does — Chrome never got the message to the
 * background at all — and is reported as `{ claimed: false, reason: 'busy' }` so a caller that only
 * checks `claimed` treats the two the same way `panel/pipelineCommands.ts` already treats a plain
 * delivery failure: stand the optimistic status down and let the candidate retry.
 */
export type ClaimOutcome = ClaimResult & { delivered: boolean };

/**
 * Sends `START_FILL` or `START_SAVE_APPLICATION` and waits for the claim's outcome — a real
 * request/response, the same reasoning as {@link updateRun}: a claim that loses produces no
 * `chrome.storage.onChanged` event for the panel to learn it from, so without an answer the caller
 * has no way to tell a refused command from one still running.
 */
function sendClaimCommand(message: StartFillMessage | StartSaveApplicationMessage) {
  return new Promise<ClaimOutcome>((resolve) => {
    chrome.runtime.sendMessage(typedMessageEnvelope(message), (response: unknown) => {
      const error = chrome.runtime.lastError;
      const parsed = ClaimResultSchema.safeParse(response);
      resolve(
        error || !parsed.success
          ? { claimed: false, reason: 'busy', delivered: false }
          : { ...parsed.data, delivered: true },
      );
    });
  });
}

/** Panel -> background: start the Fill Step, waiting for whether it actually claimed the run. */
export function startFill(message: StartFillMessage): Promise<ClaimOutcome> {
  return sendClaimCommand(message);
}

/** Panel -> background: start the Save Step, waiting for whether it actually claimed the run. */
export function startSaveApplication(message: StartSaveApplicationMessage): Promise<ClaimOutcome> {
  return sendClaimCommand(message);
}
