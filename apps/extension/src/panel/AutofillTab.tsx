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
 * and the resume preview's lifecycle. The words for a Run Notice are `RunNoticeView.tsx`'s.
 */
import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import type { JobPageData } from '../lib/messages';
import type { PostingReadOutcome } from '../lib/pageClient';
import { pipelineCommands } from './pipelineCommands';
import { canEditRun, canFill, canSave, hasFilled, hasUnsavedFill } from '../lib/run';
import type { RunNoticeAction } from '../lib/run';
import { CoverageReport } from './CoverageReport';
import { getDetectedPage, subscribeDetectedPage } from '../lib/tabStore/detectedPage';
import { type PipelineStatus } from '../lib/run';
import { questionPresentation } from './questionPresentation';
import { ResumeReview } from './ResumeReview';
import { RunNoticeView } from './RunNoticeView';
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
  readPosting?: ((tabId: number) => Promise<PostingReadOutcome>) | undefined;
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
  // What to show about this run's questions — a pure derivation from `run` and the live detection,
  // with nothing about rendering in it. See `questionPresentation.ts`.
  const {
    refinableFieldIds,
    unfilledQuestions,
    unfilledRequiredQuestions,
    hasNewApplicationQuestions,
  } = questionPresentation(run, detectedPage, outcome);

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

  /** The three retries and the duplicate override, named by `reviewOf` and performed here. */
  function runNoticeAction(action: RunNoticeAction): void {
    switch (action) {
      case 'analyze-anyway':
        return handleAnalyze(true);
      case 'retry-analysis':
        return handleAnalyze();
      case 'retry-fill':
        return handleFill();
      case 'retry-save':
        return handleSaveApplication();
    }
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
                ? 'Pull the job description off this page or paste it in, give it a read, then analyze it against the form djobi found.'
                : 'Pull the job description off this page or paste it in. djobi holds on to it if this job opens its form on another page.'}
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
                Got the posting. Give it a read, edit if needed, then analyze.
              </p>
            )}
            {jobDescription.scrapeStatus.kind === 'idle' && jobDescription.source === 'scraped' && (
              <p className="scrape-feedback" role="status">
                Still using the posting djobi pulled earlier for this job.
              </p>
            )}
            {jobDescription.scrapeStatus.kind === 'error' && (
              <div className="inline-error" role="alert">
                <p>
                  {jobDescription.scrapeStatus.reason === 'unavailable'
                    ? "djobi couldn't read this page. Reload it to reconnect, or paste the job description in yourself."
                    : "Couldn't find a job description on this page worth trusting. Paste it in instead."}
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
        {outcomeNotices.map((notice) => (
          <RunNoticeView key={notice.kind} notice={notice} onAction={runNoticeAction} />
        ))}

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
                    Wrong job title or company, or missing something? Edit the posting here and run
                    the analysis again.
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
              <div className="inline-error inline-warning" role="note">
                <div className="inline-error-body">
                  <p>
                    <strong>Read your tailored resume before you fill the form.</strong> Check every
                    bullet, and change anything that doesn't sound like your actual experience.
                  </p>
                </div>
              </div>
              {resumePreview.state.kind === 'error' && (
                <p className="preview-error" role="alert">
                  Couldn't build the preview. Try again.
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
            {inlineNotices.map((notice) => (
              <RunNoticeView key={notice.kind} notice={notice} onAction={runNoticeAction} />
            ))}
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
              {status === 'saving' ? 'Saving…' : 'Save application'}
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
