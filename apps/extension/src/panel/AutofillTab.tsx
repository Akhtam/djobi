/**
 * The "Autofill" tab: the Application Pipeline as the candidate sees it — scrape or paste a Job Description,
 * Analyze, review what came back, Fill, Save.
 *
 * A module alongside `LogApplication` and `AskTab` rather than the body of `panel/App.tsx`. Folded
 * into the shell, the shell's interface becomes "everything the pipeline renders" plus profile
 * bootstrap plus tab state, and every further tab adds to it again.
 *
 * The steps themselves run in `background/applicationPipeline.ts`, not here: the panel closing
 * mid-request must not kill a run. Progress arrives through the run this module is handed, never as
 * a response to the command that started it.
 *
 * The commands are `panel/pipelineCommands.ts`, not messages built here. Each of them pairs a
 * message with the optimistic status it raises and the failure that stands that status down, and
 * the pairing is exactly what this module kept getting to restate. What is left here is the tab's
 * own: whether a command is *eligible* — which the buttons' `disabled` and the review guards say —
 * the resume preview's lifecycle, and the words for every Run Notice.
 */
import type { DetectedField, JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import { autofillSource } from '../lib/fieldDisposition';
import { formatAppliedDate, formatStage } from '../lib/format';
import type { JobPageData } from '../lib/messages';
import { pipelineCommands } from './pipelineCommands';
import type { PostingReadOutcome } from '../lib/postingReader';
import { answersFor, canEditRun, canFill, canSave, hasFilled, hasUnsavedFill } from '../lib/run';
import type { RunFailureKind, RunNotice, RunNoticeAction, RunStep } from '../lib/run';
import { CoverageReport } from './CoverageReport';
import { getDetectedPage, subscribeDetectedPage } from '../lib/tabStore/detectedPage';
import { type PipelineStatus } from '../lib/run';
import { ResumeReview } from './ResumeReview';
import type { ActiveRun } from './useActiveRun';
import { useJobDescription } from './useJobDescription';
import { useResumePreview } from './useResumePreview';

/**
 * `'ready'` is this module's own — there is no run on this page yet — and the rest is the stored
 * run's `PipelineStatus`. The panel's bootstrap states (loading, no profile) are deliberately not
 * here: they are the shell's, and this module is only mounted once a Profile exists.
 */
type AutofillStatus = 'ready' | PipelineStatus;

function assertNever(value: never): never {
  throw new Error(`Unhandled run notice: ${JSON.stringify(value)}`);
}

function failureReason(kind: RunFailureKind, step: RunStep): string {
  switch (kind) {
    case 'temporary':
      if (step === 'fill') {
        return 'The form may have been partially filled. Check the application page before trying again.';
      }
      if (step === 'save') {
        return 'The save may have completed. Check the Dashboard before trying again.';
      }
      return 'This service is temporarily unavailable. Try again.';
    case 'backend-unreachable':
      return 'Djobi could not reach its backend. Check that it is running, then try again.';
    case 'invalid-page':
      return 'This page returned data the extension could not use. Reload the page before trying again.';
    case 'invalid-model-output':
      return 'The model returned an unusable result. Try again.';
    case 'cancelled':
      return 'This attempt was cancelled.';
    case 'unknown':
      return 'An unexpected error occurred. Try again.';
  }
}

export function AutofillTab({
  client,
  profile,
  activeRun,
  onRefineAnswer,
  hidden,
  readPosting,
}: {
  /** The backend seam, handed down by the shell — see `panel/App.tsx`. */
  client: BackendClient;
  profile: Profile;
  /** The run for the page being shown, and the operations on it — see `useActiveRun`. */
  activeRun: ActiveRun;
  /** Hands one drafted answer to the Ask Tab. Offered only for freeform questions — see below. */
  onRefineAnswer: (fieldId: string, question: string, currentAnswer: string) => void;
  /**
   * Injectable so panel tests do not need to reproduce Chrome's frame-enumeration API. Passed
   * straight through to `panel/useJobDescription.ts`, which owns the scrape and names the default.
   */
  readPosting?: (tabId: number) => Promise<PostingReadOutcome>;
  /**
   * Whether another tab is showing.
   *
   * Part of this module's interface rather than the shell's business, because it owns its own
   * footer: the Fill/Save actions sit outside the scrolling pane, as a sibling of it, so there is
   * no single element for a caller to hide. The pane stays *mounted* while hidden — a run in
   * flight must survive the candidate looking at another tab.
   */
  hidden: boolean;
}) {
  const {
    tabId,
    tabUrl,
    changeToken,
    run,
    status: runStatus,
    review,
    updateAnswer,
    updateTailoredResume,
  } = activeRun;

  const [detectedPage, setDetectedPage] = useState<JobPageData | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);

  // The Job Description, wherever it currently lives — see `panel/useJobDescription.ts`. Draft
  // versus run, Job Key scoping and the scrape's races are all its business, not this module's.
  const jobDescription = useJobDescription(activeRun, readPosting);
  const commands = pipelineCommands(activeRun, profile, jobDescription);

  const status: AutofillStatus = runStatus ?? 'ready';
  const fillEnabled = canFill(runStatus);
  const saveEnabled = canSave(runStatus);
  const editEnabled = canEditRun(runStatus);
  const showSave = hasUnsavedFill(runStatus);
  const refill = hasFilled(runStatus);
  const { canReview, outcome, notices } = review;
  // Two places, one list. `slot` is the run's own axis — *how it went* versus *this step failed,
  // retry it from here* — so the split is a filter rather than a second reading of `status`.
  const outcomeNotices = notices.filter((notice) => notice.slot === 'outcome');
  const inlineNotices = notices.filter((notice) => notice.slot === 'inline');

  // The run's snapshot wins once analysis has started; before that, the live detection does.
  const jobPageData = run?.jobPageData ?? detectedPage;
  const jobInfo: JobInfo | null = run?.jobInfo ?? null;
  const tailoredResume: TailoredResume | null = run?.tailoredResume ?? null;
  const answers = run?.answers ?? [];
  const coverage = run?.coverage ?? [];
  /**
   * Which answers may be handed to the Ask Tab: the freeform ones. A `question`-category Detected
   * Field rendered as a select, combobox or radiogroup answers from the page's own fixed options,
   * and rewriting one as prose produces something that can't be filled back in.
   */
  const refinableFieldIds = new Set(
    (jobPageData?.fields ?? [])
      .filter(
        (field) =>
          autofillSource(field.category) === 'question' &&
          field.elementRole === 'native' &&
          !field.options,
      )
      .map((field) => field.id),
  );
  // Which questions Fill will leave blank — decided by `lib/runAnswers.ts`, which is the resolution
  // Fill itself uses, given the same run. Two derivations of this rule is how the panel came to
  // warn about the wrong questions: it resolved by label set, so it flagged a remounted field whose
  // id Fill still matched, and said nothing about a question whose drafted answer had been dropped.
  //
  // Both sources of fields are handed over: a just-finished Fill scan may have checkpointed new
  // questions onto the run while panel-side detection still holds an older empty snapshot from the
  // route transition. They overlap, and `unanswered` names each question once.
  const unfilledQuestions: DetectedField[] = answersFor(run).unanswered([
    ...(run?.jobPageData.fields ?? []),
    ...(detectedPage?.fields ?? []),
  ]);
  // Only the required ones are listed: an optional question left blank is a normal outcome, and
  // naming every one of them buries the entries that actually block a submission.
  const unfilledRequiredQuestions = unfilledQuestions.filter((field) => field.required);
  // Only until a Fill reports. This banner predicts what Fill will skip; once it has run,
  // `unresolvedRequiredFields` is the page's own account of what it actually kept, and it names the
  // same questions plus any the form rejected outright. Showing both listed the same questions
  // twice, under two headings, one of them stale.
  const hasNewApplicationQuestions = outcome === null && unfilledQuestions.length > 0;

  // The Tailored Resume preview, and the blob-URL lifecycle that comes with it.
  const resumePreview = useResumePreview(client, profile, tailoredResume);

  // Form detection and previews are page-scoped. The Job Description is *not* only page-scoped —
  // a draft survives a navigation within the same job — so its own reset and restore live with it,
  // in `panel/useJobDescription.ts`.
  useEffect(() => {
    if (tabId === null) return;
    const activeTabId = tabId;

    setShowPageTextEditor(false);
    setDetectedPage(null);
    // A blob URL means nothing on a different page.
    resumePreview.clear();

    // Opportunistic only — the paste + Analyze screen is shown regardless of whether this finds
    // anything, so a page where detection fails (or hasn't finished) never blocks the user from
    // pasting the Job Description themselves.
    let current = true;
    function refreshDetectedPage() {
      void getDetectedPage(activeTabId).then((data) => {
        if (current) setDetectedPage(data);
      });
    }

    refreshDetectedPage();
    // The content script re-reports as the form mounts, and an API-oracle enrichment lands
    // separately. The store owns which shared-record writes affect this projection.
    const unsubscribe = subscribeDetectedPage(activeTabId, refreshDetectedPage);
    return () => {
      current = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route identity is the reset signal
  }, [tabId, tabUrl, changeToken]);

  function handleAnalyze(force = false) {
    // The existing blob renders the previous analysis, even when this URL has not changed. The
    // preview is this module's, so clearing it is too — the command knows nothing about it. Only
    // once the command has actually started, though: the Re-analyze beside the unfilled-questions
    // notice is enabled whatever the Job Description says, so a candidate who has emptied the
    // textarea can press it, and dropping the rendered preview for an analysis that never ran
    // would cost them the render for nothing.
    if (commands.analyze(force)) resumePreview.clear();
  }

  function handleFill() {
    if (!jobPageData || !jobInfo || !tailoredResume) return;
    commands.fill();
  }

  function handleResumeReviewChange(next: TailoredResume) {
    if (!run) return;
    updateTailoredResume(run.runId, next);
    // The open preview iframe still points at the pre-edit render; clearing it drops back to the
    // "Preview tailored resume" button rather than showing bytes that no longer match what Fill will
    // actually write, the same reasoning `handleAnalyze` already applies to a stale preview.
    resumePreview.clear();
  }

  function handleSaveApplication() {
    if (!saveEnabled) return;
    commands.save();
  }

  /** The three retries and the duplicate override, named by `reviewOf` and bound here. */
  function runNoticeAction(action: RunNoticeAction): () => void {
    switch (action) {
      case 'analyze-anyway':
        return () => handleAnalyze(true);
      case 'retry-analysis':
        return () => handleAnalyze();
      case 'retry-fill':
        return handleFill;
      case 'retry-save':
        return handleSaveApplication;
    }
  }

  /**
   * The words for one Run Notice.
   *
   * `reviewOf` says which situation the run is in; this says the sentence, because the wording is a
   * product judgement — "reload the page" versus "fill it in by hand" sends the candidate after two
   * different problems — and it belongs next to the JSX a person reads. The `switch` is exhaustive
   * over `RunNotice['kind']`, so a notice added there fails to compile until it has copy here.
   */
  function renderNotice(notice: RunNotice) {
    switch (notice.kind) {
      case 'duplicate':
        return (
          <div className="state" role="status" key={notice.kind}>
            <span className="state-icon">📮</span>
            <p>
              {notice.duplicate.count > 1
                ? `You've already applied to this job ${notice.duplicate.count} times, most recently on ${formatAppliedDate(notice.duplicate.createdAt)}.`
                : `You already applied to this job on ${formatAppliedDate(notice.duplicate.createdAt)}.`}
            </p>
            <p className="failure-detail">
              {notice.duplicate.roleTitle} at {notice.duplicate.company} ·{' '}
              {formatStage(notice.duplicate.stage)}
            </p>
            <button type="button" className="btn-primary" onClick={runNoticeAction(notice.action)}>
              Analyze and apply anyway
            </button>
          </div>
        );

      case 'analyze-failed':
        return (
          <div className="state error" role="alert" key={notice.kind}>
            <span className="state-icon error">⚠️</span>
            <p>Something went wrong analyzing this job posting.</p>
            <p>{failureReason(notice.reason, 'analysis')}</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={runNoticeAction(notice.action)}
            >
              Try again
            </button>
          </div>
        );

      case 'fill-unverified':
        return (
          <div className="state error" role="alert" key={notice.kind}>
            <span className="state-icon error">⚠️</span>
            <p>
              The fill could not be verified because this page did not answer. Check the form before
              submitting or saving, and reload the page before trying again if fields are still
              empty.
            </p>
          </div>
        );

      case 'no-fields-detected':
        return (
          <div className="state error" role="alert" key={notice.kind}>
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — no form fields were found on this page, including in a fresh scan
              taken just now. You'll need to fill the form yourself before saving this application.
              If the form is visibly there, reload the page and try again: this extension can't
              reach a page that was already open when it was last reloaded.
            </p>
          </div>
        );

      // The other zero-filled outcome, and a different problem: the form was read fine and then
      // kept none of what was written into it. Reloading is not the advice here — the list of
      // fields to fill by hand is.
      case 'nothing-filled':
        return (
          <div className="state error" role="alert" key={notice.kind}>
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — this page's form was found ({notice.detectedFieldCount} field
              {notice.detectedFieldCount === 1 ? '' : 's'}), but it kept none of the values written
              into it. You'll need to fill it in yourself before saving this application.
            </p>
          </div>
        );

      case 'fill-complete':
        return (
          <div className="state success compact" role="status" key={notice.kind}>
            <span className="state-icon success">✅</span>
            <p>
              Filled {notice.filledFieldCount} field{notice.filledFieldCount === 1 ? '' : 's'}. Save
              the application when you're ready.
            </p>
          </div>
        );

      case 'fill-incomplete':
        return (
          <div className="state error" role="alert" key={notice.kind}>
            <span className="state-icon error">⚠️</span>
            <p>
              Filled, but {notice.unresolvedRequiredFields.length} required field
              {notice.unresolvedRequiredFields.length === 1 ? '' : 's'} didn't take a value — fill{' '}
              {notice.unresolvedRequiredFields.length === 1 ? 'it' : 'them'} in by hand before
              submitting:
            </p>
            <ul className="unresolved-fields">
              {notice.unresolvedRequiredFields.map((field) => (
                <li key={field.id}>{field.label || field.category}</li>
              ))}
            </ul>
          </div>
        );

      case 'saved':
        return (
          <div className="state success compact" role="status" key={notice.kind}>
            <span className="state-icon success">✅</span>
            <p>Application saved.</p>
          </div>
        );

      case 'fill-failed':
      case 'save-failed':
        return (
          <div className="inline-error" role="alert" key={notice.kind}>
            <div className="inline-error-body">
              <p>
                {notice.kind === 'fill-failed'
                  ? 'Something went wrong filling the form.'
                  : 'Something went wrong saving the application.'}
              </p>
              <p>{failureReason(notice.reason, notice.kind === 'fill-failed' ? 'fill' : 'save')}</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={runNoticeAction(notice.action)}
            >
              Try again
            </button>
          </div>
        );
    }
    return assertNever(notice);
  }

  return (
    <>
      <div className="panel-body" hidden={hidden}>
        {status === 'ready' && (
          <div className="review">
            <div className="review-header">
              <span className="eyebrow">
                {jobPageData ? 'Job page detected' : 'No form detected yet'}
              </span>
              <h2>Ready to analyze</h2>
            </div>
            <p className="hint">
              {jobPageData
                ? 'Paste a job description or extract it from this page, review the text, then analyze it for this detected form.'
                : 'Paste a job description or extract it from this page. It will be retained if this job opens its application form on another route.'}
            </p>
            <label className="field-label" htmlFor="job-description">
              Job description
            </label>
            <textarea
              id="job-description"
              className="page-text-input"
              placeholder="Paste the job description here…"
              value={jobDescription.text}
              onChange={(e) => jobDescription.edit(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={jobDescription.scrape}
              disabled={!jobDescription.canScrape}
            >
              {jobDescription.scrapeStatus.kind === 'loading'
                ? 'Extracting job posting…'
                : 'Extract job posting'}
            </button>
            {jobDescription.scrapeStatus.kind === 'success' && (
              <p className="scrape-feedback" role="status">
                Job posting extracted. Review or edit it before analyzing.
              </p>
            )}
            {jobDescription.scrapeStatus.kind === 'idle' && jobDescription.source === 'scraped' && (
              <p className="scrape-feedback" role="status">
                Extracted job posting retained for this job.
              </p>
            )}
            {jobDescription.scrapeStatus.kind === 'error' && (
              <div className="inline-error" role="alert">
                <p>
                  {jobDescription.scrapeStatus.reason === 'unavailable'
                    ? 'This page could not be read. Reload it to reconnect the extension, or paste the job description.'
                    : 'No confident job description was found on this page. Paste it instead.'}
                </p>
              </div>
            )}
            <button
              type="button"
              className="btn-primary"
              onClick={() => handleAnalyze()}
              disabled={!jobDescription.text.trim() || !jobDescription.analysisUrl}
            >
              Analyze
            </button>
          </div>
        )}

        {status === 'analyzing' && (
          <div className="state" role="status" aria-live="polite">
            <span className="spinner" />
            <p>Analyzing job posting…</p>
          </div>
        )}

        {/* Everything this run has to say about how it went, in `reviewOf`'s order. Above the review
            and not below it: the review is long, and a result the user has to scroll past it to
            find is a result they won't see. */}
        {outcomeNotices.map(renderNotice)}

        {canReview && jobInfo && tailoredResume && jobPageData && (
          <div className="review">
            <div className="review-header">
              <span className="eyebrow">{jobInfo.company}</span>
              <h2>
                {jobInfo.roleTitle} at {jobInfo.company}
              </h2>
            </div>

            {hasNewApplicationQuestions && (
              <div className="inline-error inline-warning" role="status">
                <div className="inline-error-body">
                  {unfilledRequiredQuestions.length > 0 ? (
                    <>
                      <p>
                        {unfilledRequiredQuestions.length} required question
                        {unfilledRequiredQuestions.length === 1 ? '' : 's'} won't be filled:
                      </p>
                      <ul className="unresolved-fields">
                        {unfilledRequiredQuestions.map((field) => (
                          <li key={field.id}>{field.label}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      {unfilledQuestions.length} optional question
                      {unfilledQuestions.length === 1 ? '' : 's'} won't be filled.
                    </p>
                  )}
                </div>
                <button type="button" className="btn-secondary" onClick={() => handleAnalyze()}>
                  Re-analyze
                </button>
              </div>
            )}

            <div className="page-text-editor">
              <button
                type="button"
                className="btn-link"
                onClick={() => setShowPageTextEditor((prev) => !prev)}
              >
                {showPageTextEditor ? 'Hide job description editor' : 'Edit job description'}
              </button>
              {showPageTextEditor && (
                <>
                  <p className="hint">
                    Wrong job title, company, or missing context? Edit the job description here and
                    re-analyze.
                  </p>
                  <label className="field-label" htmlFor="review-job-description">
                    Job description
                  </label>
                  <textarea
                    id="review-job-description"
                    className="page-text-input"
                    value={jobDescription.text}
                    disabled={!editEnabled}
                    onChange={(e) => jobDescription.edit(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleAnalyze()}
                    disabled={!jobDescription.text.trim() || !editEnabled}
                  >
                    Re-analyze
                  </button>
                </>
              )}
            </div>

            <div className="resume-preview">
              <div className="resume-preview-head">
                <span className="eyebrow">Tailored resume</span>
                <button
                  type="button"
                  className="btn-secondary resume-preview-toggle"
                  onClick={resumePreview.show}
                  disabled={resumePreview.state.kind === 'loading'}
                >
                  {resumePreview.state.kind === 'loading'
                    ? 'Rendering…'
                    : 'Preview tailored resume'}
                </button>
              </div>
              {resumePreview.state.kind === 'error' && (
                <p className="preview-error" role="alert">
                  Couldn't render the resume preview — try again.
                </p>
              )}
              {resumePreview.state.kind === 'ready' && (
                <iframe
                  className="resume-preview-frame"
                  src={resumePreview.state.url}
                  title="Tailored resume"
                />
              )}
            </div>

            {tailoredResume && (
              <ResumeReview
                tailoredResume={tailoredResume}
                profile={profile}
                editable={editEnabled}
                onChange={handleResumeReviewChange}
              />
            )}

            <CoverageReport coverage={coverage} />

            {run && answers.length > 0 && (
              <div className="questions">
                {answers.map((answer) => (
                  <div className="question-card-group" key={answer.fieldId}>
                    <label className="question-card">
                      <span>{answer.question}</span>
                      <textarea
                        value={answer.answer}
                        disabled={!editEnabled}
                        onChange={(e) => updateAnswer(run.runId, answer.fieldId, e.target.value)}
                      />
                    </label>
                    {refinableFieldIds.has(answer.fieldId) && (
                      <button
                        type="button"
                        className="btn-link"
                        disabled={!editEnabled}
                        onClick={() =>
                          onRefineAnswer(answer.fieldId, answer.question, answer.answer)
                        }
                      >
                        Refine with AI
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* This step failed — retry it from beside the answers it would have you re-fill. */}
            {inlineNotices.map(renderNotice)}
          </div>
        )}
      </div>

      {!hidden && canReview && jobInfo && tailoredResume && (
        <footer className="panel-footer">
          {/*
            Save sits above Fill once the form has been filled, because from that point on it is the
            step the candidate is actually on: Fill has already happened, and the button below it
            reads "Fill form again" — a repeat, not the way forward. Ordering the repeat first put
            the recovery action where the next action belongs.
          */}
          {showSave && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleSaveApplication}
              disabled={!saveEnabled}
            >
              {status === 'saving' && <span className="spinner" />}
              {status === 'saving' ? 'Saving...' : 'Save application'}
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={handleFill}
            disabled={!fillEnabled}
          >
            {status === 'filling' && <span className="spinner" />}
            {refill ? 'Fill form again' : 'Fill form'}
          </button>
        </footer>
      )}
    </>
  );
}
