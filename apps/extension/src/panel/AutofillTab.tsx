/**
 * The "Autofill" tab: the Application Pipeline as the candidate sees it — scrape or paste a Job Description,
 * Analyze, review what came back, Fill, Save.
 *
 * A module alongside `LogApplication` and `AskTab` rather than the body of `panel/App.tsx`, which
 * is what it used to be. The other two flows had always been modules; this one stayed in the shell,
 * so the shell's interface was "everything the pipeline renders" plus profile bootstrap plus tab
 * state, and a fourth tab would have added to it again.
 *
 * The steps themselves run in `background/applicationPipeline.ts`, not here: the panel closing
 * mid-request must not kill a run. `START_ANALYSIS`/`START_FILL`/`START_SAVE_APPLICATION` are
 * fire-and-forget notifications; real progress arrives through the run this module is handed.
 * `begin` is only instant feedback until the background writes its own status, and is never
 * persisted — see the ownership note on `usePipelineRun`.
 */
import type { DetectedField, JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import { formatAppliedDate, formatStage } from '../lib/format';
import type { JobPageData } from '../lib/messages';
import { notify } from '../lib/messages';
import type { PostingReadOutcome } from '../lib/postingReader';
import { answersFor } from '../lib/runAnswers';
import { reviewOf } from '../lib/runReview';
import { getDetectedPage, storageKey, type PipelineStatus } from '../lib/tabStore';
import type { ActiveRun } from './useActiveRun';
import { useJobDescription } from './useJobDescription';
import { useResumePreview } from './useResumePreview';

/**
 * `'ready'` is this module's own — there is no run on this page yet — and the rest is the stored
 * run's `PipelineStatus`. The panel's bootstrap states (loading, no profile) are deliberately not
 * here: they are the shell's, and this module is only mounted once a Profile exists.
 */
type AutofillStatus = 'ready' | PipelineStatus;

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
    begin,
    edit,
    updateAnswer,
  } = activeRun;

  const [detectedPage, setDetectedPage] = useState<JobPageData | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);

  // The Job Description, wherever it currently lives — see `panel/useJobDescription.ts`. Draft
  // versus run, Job Key scoping and the scrape's races are all its business, not this module's.
  const jobDescription = useJobDescription(activeRun, readPosting);

  const status: AutofillStatus = runStatus ?? 'ready';
  const { canReview, outcome } = reviewOf(run);

  // The run's snapshot wins once analysis has started; before that, the live detection does.
  const jobPageData = run?.jobPageData ?? detectedPage;
  const jobInfo: JobInfo | null = run?.jobInfo ?? null;
  const tailoredResume: TailoredResume | null = run?.tailoredResume ?? null;
  const answers = run?.answers ?? [];
  const unresolvedRequiredFields = run?.unresolvedRequiredFields ?? [];
  const filledFieldCount = run?.filledFieldCount ?? 0;
  const failure = run?.failure ?? null;
  /** How many fields the run's own re-scan saw — what separates the two zero-filled outcomes. */
  const detectedFieldCount = jobPageData?.fields.length ?? 0;
  const duplicateOf = run?.duplicateOf ?? null;
  /**
   * Which answers may be handed to the Ask Tab: the freeform ones. A `question`-category Detected
   * Field rendered as a select, combobox or radiogroup answers from the page's own fixed options,
   * and rewriting one as prose produces something that can't be filled back in.
   */
  const refinableFieldIds = new Set(
    (jobPageData?.fields ?? [])
      .filter(
        (field) =>
          field.category === 'question' && field.elementRole === 'native' && !field.options,
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
    const key = storageKey(activeTabId);
    function onStorageChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) {
      if (areaName === 'session' && key in changes) refreshDetectedPage();
    }
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      current = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- route identity is the reset signal
  }, [tabId, tabUrl, changeToken]);

  /**
   * `force` is set only by "Analyze and apply anyway", after the background told us this job URL
   * already has a saved Application. The Duplicate Guard itself runs in the background, not here,
   * so every entry point into analysis is covered by it.
   */
  function handleAnalyze(force = false) {
    if (!jobDescription.text.trim() || tabId === null || !jobDescription.analysisUrl) return;

    begin('analyzing');

    notify({
      type: 'START_ANALYSIS',
      tabId,
      tabUrl: jobDescription.analysisUrl,
      profile,
      jobDescription: jobDescription.text,
      force,
    });
  }

  function handleFill() {
    if (!jobPageData || !jobInfo || !tailoredResume || tabId === null) return;

    begin('filling');

    notify({ type: 'START_FILL', tabId, profile });
  }

  function handleSaveApplication() {
    if (tabId === null || (status !== 'filled' && status !== 'save-error')) return;

    begin('saving');
    notify({ type: 'START_SAVE_APPLICATION', tabId });
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
                ? 'Paste a job description or scrape it from this page, review the text, then analyze it for this detected form.'
                : 'Paste a job description or scrape it from this page. It will be retained if this job opens its application form on another route.'}
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
                ? 'Scraping job description…'
                : 'Scrape job description'}
            </button>
            {jobDescription.scrapeStatus.kind === 'success' && (
              <p className="scrape-feedback" role="status">
                Job description scraped. Review or edit it before analyzing.
              </p>
            )}
            {jobDescription.scrapeStatus.kind === 'idle' && jobDescription.source === 'scraped' && (
              <p className="scrape-feedback" role="status">
                Scraped job description retained for this job.
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

        {status === 'duplicate' && duplicateOf && (
          <div className="state" role="status">
            <span className="state-icon">📮</span>
            <p>
              {duplicateOf.count > 1
                ? `You've already applied to this job ${duplicateOf.count} times, most recently on ${formatAppliedDate(duplicateOf.createdAt)}.`
                : `You already applied to this job on ${formatAppliedDate(duplicateOf.createdAt)}.`}
            </p>
            <p className="failure-detail">
              {duplicateOf.roleTitle} at {duplicateOf.company} · {formatStage(duplicateOf.stage)}
            </p>
            <button type="button" className="btn-primary" onClick={() => handleAnalyze(true)}>
              Analyze and apply anyway
            </button>
          </div>
        )}

        {status === 'analyze-error' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>Something went wrong analyzing this job posting.</p>
            {failure && <p className="failure-detail">{failure.message}</p>}
            <button type="button" className="btn-secondary" onClick={() => handleAnalyze()}>
              Try again
            </button>
          </div>
        )}

        {/* The Fill Step's outcome sits above the review, not below it: the review is long, and a
            result the user has to scroll past it to find is a result they won't see. */}
        {outcome === 'unverified' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>
              The fill could not be verified because this page did not answer. Check the form before
              submitting or saving, and reload the page before trying again if fields are still
              empty.
            </p>
          </div>
        )}

        {outcome === 'no-fields-detected' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — no form fields were found on this page, including in a fresh scan
              taken just now. You'll need to fill the form yourself before saving this application.
              If the form is visibly there, reload the page and try again: this extension can't
              reach a page that was already open when it was last reloaded.
            </p>
          </div>
        )}

        {/* The other zero-filled outcome, and a different problem: the form was read fine and then
            kept none of what was written into it. Reloading is not the advice here — the list of
            fields to fill by hand is. */}
        {outcome === 'nothing-filled' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — this page's form was found ({detectedFieldCount} field
              {detectedFieldCount === 1 ? '' : 's'}), but it kept none of the values written into
              it. You'll need to fill it in yourself before saving this application.
            </p>
          </div>
        )}

        {outcome === 'complete' && (
          <div className="state success" role="status">
            <span className="state-icon success">✅</span>
            <p>
              Filled {filledFieldCount} field{filledFieldCount === 1 ? '' : 's'}. Save the
              application when you're ready.
            </p>
          </div>
        )}

        {outcome === 'incomplete' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>
              Filled, but {unresolvedRequiredFields.length} required field
              {unresolvedRequiredFields.length === 1 ? '' : 's'} didn't take a value — fill{' '}
              {unresolvedRequiredFields.length === 1 ? 'it' : 'them'} in by hand before submitting:
            </p>
            <ul className="unresolved-fields">
              {unresolvedRequiredFields.map((field) => (
                <li key={field.id}>{field.label || field.category}</li>
              ))}
            </ul>
          </div>
        )}

        {status === 'saved' && (
          <div className="state success" role="status">
            <span className="state-icon success">✅</span>
            <p>Application saved.</p>
          </div>
        )}

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
                    disabled={status === 'saving'}
                    onChange={(e) => jobDescription.edit(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleAnalyze()}
                    disabled={!jobDescription.text.trim() || status === 'saving'}
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

            {answers.length > 0 && (
              <div className="questions">
                {answers.map((answer) => (
                  <div className="question-card-group" key={answer.fieldId}>
                    <label className="question-card">
                      <span>{answer.question}</span>
                      <textarea
                        value={answer.answer}
                        disabled={status === 'saving'}
                        onChange={(e) => updateAnswer(answer.fieldId, e.target.value)}
                      />
                    </label>
                    {refinableFieldIds.has(answer.fieldId) && (
                      <button
                        type="button"
                        className="btn-link"
                        disabled={status === 'saving'}
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

            {status === 'fill-error' && (
              <div className="inline-error" role="alert">
                <div className="inline-error-body">
                  <p>Something went wrong filling the form.</p>
                  {failure && <p className="failure-detail">{failure.message}</p>}
                </div>
                <button type="button" className="btn-secondary" onClick={handleFill}>
                  Try again
                </button>
              </div>
            )}
            {status === 'save-error' && (
              <div className="inline-error" role="alert">
                <div className="inline-error-body">
                  <p>Something went wrong saving the application.</p>
                  {failure && <p className="failure-detail">{failure.message}</p>}
                </div>
                <button type="button" className="btn-secondary" onClick={handleSaveApplication}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!hidden && canReview && jobInfo && tailoredResume && (
        <footer className="panel-footer">
          <button
            type="button"
            className="btn-primary"
            onClick={handleFill}
            disabled={status === 'filling' || status === 'saving'}
          >
            {status === 'filling' && <span className="spinner" />}
            {status === 'filled' || status === 'saved' || status === 'save-error'
              ? 'Fill form again'
              : 'Fill form'}
          </button>
          {(status === 'filled' || status === 'save-error' || status === 'saving') && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleSaveApplication}
              disabled={status === 'saving'}
            >
              {status === 'saving' && <span className="spinner" />}
              {status === 'saving' ? 'Saving...' : 'Save application'}
            </button>
          )}
        </footer>
      )}
    </>
  );
}
