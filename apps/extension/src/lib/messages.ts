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
 * What the content script reports on detecting an application form: the fields, nothing else.
 * Posting text comes only from the explicit `SCRAPE_JOB_DESCRIPTION` request.
 */
export const JobPageDataSchema = z.strictObject({ fields: z.array(DetectedFieldSchema) });
export type JobPageData = ZodTypeOf<typeof JobPageDataSchema>;

/** Content script -> background: reports a detected job page. No response. */
export const ReportJobPageMessageSchema = JobPageDataSchema.extend({
  type: z.literal('REPORT_JOB_PAGE'),
}).strict();
export type ReportJobPageMessage = ZodTypeOf<typeof ReportJobPageMessageSchema>;

/**
 * Panel -> background: start the Analysis Step for `tabId`. No response payload; progress is
 * observed through `chrome.storage.onChanged`, so the panel can close meanwhile.
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
 * Panel -> background: start the Fill Step for `tabId`. `expectedRunId` names the run the panel
 * meant, so a command delayed past a re-analysis can't fill another posting's form (see
 * `background/runClaim.ts`).
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
      /** The candidate's resume review edits (`panel/ResumeReview.tsx`); omitted = unchanged. */
      tailoredResume: TailoredResumeSchema.optional(),
    }),
    // No `status`: whether a saved run reverts to `filled` is decided by `applyPanelEdit` from what
    // actually changed.
  })
  .strict();
export type UpdateRunMessage = ZodTypeOf<typeof UpdateRunMessageSchema>;

/** Background -> panel: whether an `UPDATE_RUN` edit was actually written. */
export const UpdateRunResultSchema = z.strictObject({ applied: z.boolean() });
export type UpdateRunResult = ZodTypeOf<typeof UpdateRunResultSchema>;

/**
 * Background -> panel: whether `START_FILL`/`START_SAVE_APPLICATION` claimed the run, sent as soon
 * as the claim is decided. `'busy'`: another step holds it (e.g. a second panel); `'stale-run'`:
 * the command named a superseded run. See `panel/pipelineCommands.ts`.
 */
export const ClaimResultSchema = z.discriminatedUnion('claimed', [
  z.strictObject({ claimed: z.literal(true) }),
  z.strictObject({ claimed: z.literal(false), reason: z.enum(['busy', 'stale-run']) }),
]);
export type ClaimResult = ZodTypeOf<typeof ClaimResultSchema>;

/**
 * {@link updateRun}'s result. `delivered: false` means nothing answered (worker restarting,
 * unparseable reply) — retryable, so the caller keeps its optimistic copy — as opposed to the store
 * refusing the edit.
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
  /** The run this fill belongs to, so a later observed submission can name it. */
  runId: string;
  fields: DetectedField[];
  values: Record<string, string>;
  resumeFile?: { name: string; type: string; bytes: number[] } | undefined;
}

/**
 * The page's account of a fill: ids of fields whose value was verifiably still there afterwards,
 * and whether the resume attached. See `content/fillForm.ts`.
 */
export const FillFormResultSchema = z.strictObject({
  ok: z.literal(true),
  filledFieldIds: z.array(z.string()),
  resumeAttached: z.boolean(),
});
export type FillFormResult = ZodTypeOf<typeof FillFormResultSchema>;

/**
 * Background -> content, sent directly by `applicationPipeline.ts` (not relayed via
 * `TypedMessage`): fill this tab's form. Response: {@link FillFormResult}.
 */
export interface FillFormCommandMessage extends FillFormPayload {
  type: 'FILL_FORM';
}

/**
 * Background -> content: re-scan now and answer with the current fields, so the Fill Step fills
 * what's on the page rather than what was there at analysis. Only frames holding a form reply.
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
 * Background -> content: show an on-page "application recorded" toast. Best-effort (the submit
 * usually navigated the tab); `background/saveBadge.ts` is the confirmation that survives.
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
 * Content script -> background: the candidate submitted a form this extension filled. `runId` names
 * the filled run, so a submission reported after the tab moved on can't save another posting's run.
 */
export const ReportSubmissionMessageSchema = z.strictObject({
  type: z.literal('REPORT_SUBMISSION'),
  runId: z.string().min(1),
});
export type ReportSubmissionMessage = ZodTypeOf<typeof ReportSubmissionMessageSchema>;

/**
 * Panel -> background: the panel is watching a step that claims to be running. Its handler does
 * nothing — **waking the worker is the point**, since only a starting worker runs the recovery
 * sweep that repairs a step Chrome killed. A no-op if the worker is alive.
 */
export const CheckRunMessageSchema = z.strictObject({
  type: z.literal('CHECK_RUN'),
  tabId: z.number().int().nonnegative(),
});
export type CheckRunMessage = ZodTypeOf<typeof CheckRunMessageSchema>;

/**
 * The coordination protocol: content script and panel telling the background something happened.
 * **Notification-only by default**: steps must outlive their sender, so progress is read from
 * `lib/tabStore/pipelineRun.ts`, not replies. Exceptions — because a refusal writes nothing to
 * observe — are `UPDATE_RUN` ({@link UpdateRunResult}) and `START_FILL`/`START_SAVE_APPLICATION`
 * ({@link ClaimResult}). Background -> content request/response messages live in
 * `lib/pageClient.ts`.
 */
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

/**
 * Independent of the manifest version: bump only when this coordination protocol is incompatible.
 */
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
 * Sends a coordination message and returns immediately; the callback only sees the empty receipt.
 * `onDispatchError` lets START callers stand down optimistic UI when Chrome couldn't deliver.
 */
export function notify(message: TypedMessage, onDispatchError?: (message: string) => void): void {
  chrome.runtime.sendMessage(typedMessageEnvelope(message), () => {
    const error = chrome.runtime.lastError;
    if (error)
      onDispatchError?.(error.message || 'The background worker did not receive the command.');
  });
}

/**
 * Sends `UPDATE_RUN` and waits for the store's answer. Unlike other panel messages, an edit is one
 * fast write the run domain may refuse (e.g. mid-save), and a refusal writes nothing observable.
 *
 * No listener or an unparseable reply yields `applied: false, delivered: false`, distinct from the
 * store's own refusal — see {@link UpdateRunOutcome}.
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
 * A claim attempt's result. Undelivered is reported as `{ claimed: false, reason: 'busy' }` with
 * `delivered: false`, so callers checking only `claimed` stand down as for any refusal.
 */
export type ClaimOutcome = ClaimResult & { delivered: boolean };

/**
 * Sends `START_FILL`/`START_SAVE_APPLICATION` and waits for the claim outcome — a lost claim writes
 * nothing the panel could observe.
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
