/**
 * Review UI root, mounted by `panel/main.tsx` as the side panel's sole content (see
 * `manifest.ts`'s `side_panel.default_path` — there's no popup). Once a profile exists, tracks the
 * active tab and reads the job page the content script reported for it from `lib/tabStore.ts` — the
 * content script itself runs on every page and decides
 * whether it's a job application form (see `detect.ts`), not a fixed ATS-host allowlist, since
 * ATS platforms let companies white-label their job board onto their own domain. Analysis starts
 * only when the candidate clicks Analyze; `background/applicationPipeline.ts` runs it so it survives
 * this component unmounting mid-run. The panel shows an editable review hydrated from and
 * checkpointed to `lib/tabStore.ts` once results land.
 *
 * The panel survives switching tabs (unlike a popup, which is destroyed on any outside click) —
 * it re-tracks the active tab instead of remounting, so it resets back to the bootstrap state
 * itself on tab change (see the effect below).
 */
import type {
  DetectedField,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { useEffect, useRef, useState } from 'react';
import './App.css';
import icon48 from '../assets/icons/icon48.png';
import { httpBackendClient } from '../lib/backendClient';
import { formatAppliedDate } from '../lib/format';
import type { JobPageData } from '../lib/messages';
import { notify } from '../lib/messages';
import { reviewOf } from '../lib/runReview';
import { getDetectedPage, type PipelineStatus } from '../lib/tabStore';
import { ThemeToggle, useThemePreference } from '../lib/theme';
import { LogApplication } from './LogApplication';
import { useActiveTab } from './useActiveTab';
import { usePipelineRun } from './usePipelineRun';

// 'loading'/'no-profile'/'ready' are bootstrap-only, local to this component; the rest is
// `PipelineRunState`'s `PipelineStatus`, checkpointed to `tabStore` as it progresses.
//
// What the run *means* — the pill, whether the review stays up, how the Fill Step went — is not
// derived here. It is `reviewOf` in `lib/runReview.ts`, one derivation the whole component reads.
type Status = 'loading' | 'profile-error' | 'no-profile' | 'ready' | PipelineStatus;

/**
 * Which of the panel's two flows is showing. A tab rather than a mode toggle on one flow: the Log
 * tab shares no state with the pipeline — no tracked tab, no detected form, no `PipelineStatus` —
 * so folding it in would mean threading a second meaning through every branch of `reviewOf`.
 */
type PanelTab = 'autofill' | 'log';

export function App() {
  const { theme, toggleTheme } = useThemePreference();
  const [tab, setTab] = useState<PanelTab>('autofill');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRequestRef = useRef(0);
  const [detectedPage, setDetectedPage] = useState<JobPageData | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);
  // The pasted job description before any run exists — once one does, it lives on the run.
  const [localPageText, setLocalPageText] = useState<string | null>(null);

  // The tracked tab, and everything `chrome.tabs` — the panel survives a tab switch, so it follows.
  const { tabId, tabUrl, changeToken } = useActiveTab(Boolean(profile));

  // The stored run — hydration, the storage subscription, the optimistic status and write-back all
  // live in the hook.
  const {
    run: storedRun,
    status: storedRunStatus,
    begin,
    edit,
  } = usePipelineRun(tabId, changeToken);
  // Navigation updates the tracked URL before the service worker's async storage cleanup lands.
  // Never render or act on a run captured from a different page in that gap.
  const run = storedRun?.tabUrl === tabUrl ? storedRun : null;
  const runStatus = storedRun ? (run ? storedRunStatus : null) : storedRunStatus;

  const status: Status = !profileLoaded
    ? 'loading'
    : profileError
      ? 'profile-error'
      : !profile
        ? 'no-profile'
        : (runStatus ?? 'ready');

  // The run's snapshot wins once analysis has started; before that, the live detection does.
  const jobPageData = run?.jobPageData ?? detectedPage;
  const jobInfo = run?.jobInfo ?? null;
  const tailoredResume = run?.tailoredResume ?? null;
  const answers = run?.answers ?? [];
  const unresolvedRequiredFields = run?.unresolvedRequiredFields ?? [];
  const filledFieldCount = run?.filledFieldCount ?? 0;
  const failure = run?.failure ?? null;
  /** How many fields the run's own re-scan saw — what separates the two zero-filled outcomes. */
  const detectedFieldCount = jobPageData?.fields.length ?? 0;
  const duplicateOf = run?.duplicateOf ?? null;
  // The pasted job description: the run's copy once analysis has started, the panel-local draft
  // before that. It is the only input the Analysis Step has — nothing is read off the page.
  const jobDescription = run ? run.jobDescription : (localPageText ?? '');

  // On-demand tailored-resume PDF preview (POST /render-resume-pdf, shown in an iframe from a
  // blob: URL). Kept out of the persisted `PipelineRunState` — it's a
  // display-only, expensive-to-recompute blob URL that shouldn't survive a panel reopen.
  const [resumePreview, setResumePreview] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' }
  >({ kind: 'idle' });
  const resumeUrlRef = useRef<string | null>(null);
  const resumePreviewRequestRef = useRef(0);

  // Everything scoped to the page being shown, dropped whenever that page changes — a different
  // tab, or a navigation within one. `useActiveTab` reports both as a bumped `changeToken`; the
  // service worker clears persisted state on navigation and `usePipelineRun` reflects that removal.
  useEffect(() => {
    if (tabId === null) return;

    setShowPageTextEditor(false);
    setLocalPageText(null);
    setDetectedPage(null);
    clearResumePreview();

    // Opportunistic only — the paste + Analyze screen is shown regardless of whether this finds
    // anything, so a page where detection fails (or hasn't finished) never blocks the user from
    // pasting the job description themselves.
    let current = true;
    void getDetectedPage(tabId).then((data) => {
      if (current && data) setDetectedPage(data);
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changeToken` is the reset signal
  }, [tabId, changeToken]);

  function loadProfile() {
    const requestToken = ++profileRequestRef.current;
    setProfileLoaded(false);
    setProfileError(false);
    void httpBackendClient
      .getProfile()
      .then((loadedProfile) => {
        if (requestToken !== profileRequestRef.current) return;
        setProfile(loadedProfile);
        setProfileLoaded(true);
      })
      .catch(() => {
        if (requestToken !== profileRequestRef.current) return;
        setProfileError(true);
        setProfileLoaded(true);
      });
  }

  useEffect(() => {
    loadProfile();
    return () => {
      ++profileRequestRef.current;
    };
    // Profile bootstrap runs once; retries are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release the preview's blob: URL when the panel unmounts (the blob outlives the component's
  // state, so without this revoked here it'd leak until the browser reclaims it).
  useEffect(() => {
    return () => {
      ++resumePreviewRequestRef.current;
      if (resumeUrlRef.current) URL.revokeObjectURL(resumeUrlRef.current);
    };
  }, []);

  // Analysis/Fill Step execution lives in `background/applicationPipeline.ts`, not here — the panel
  // closing mid-request must not kill it. `START_ANALYSIS`/`START_FILL` fire-and-forget (the
  // background handler doesn't hold the response channel open); real progress arrives through
  // `usePipelineRun`'s storage subscription. `begin` is only instant UI feedback until the
  // background writes its own status, and is never persisted — see the ownership note on the hook.

  /**
   * `force` is set only by "Analyze and apply anyway", after the background told us this job URL
   * already has a saved application. The check itself runs in the background, not here, so every
   * entry point into analysis is covered by it.
   */
  function handleAnalyze(force = false) {
    if (!jobDescription.trim() || tabId === null || !tabUrl || !profile) return;

    begin('analyzing');

    notify({
      type: 'START_ANALYSIS',
      tabId,
      tabUrl,
      profile,
      jobDescription,
      force,
    });
  }

  function editJobDescription(value: string) {
    if (status === 'saving') return;
    if (run) edit({ answers, jobDescription: value });
    else setLocalPageText(value);
  }

  function updateAnswer(fieldId: string, value: string) {
    if (status === 'saving') return;
    edit({
      answers: answers.map((answer) =>
        answer.fieldId === fieldId ? { ...answer, answer: value } : answer,
      ),
      jobDescription,
      ...(status === 'saved' ? { status: 'filled' as const } : {}),
    });
  }

  function handleFill() {
    if (!jobPageData || !profile || !jobInfo || !tailoredResume || tabId === null) return;

    begin('filling');

    notify({ type: 'START_FILL', tabId, profile });
  }

  function handleSaveApplication() {
    if (tabId === null || (status !== 'filled' && status !== 'save-error')) return;

    begin('saving');
    notify({ type: 'START_SAVE_APPLICATION', tabId });
  }

  /** Releases the preview's blob: URL and resets the resume-preview state (used on preview
   *  regeneration and whenever the tracked tab changes, since a URL is meaningless without its blob). */
  function clearResumePreview() {
    ++resumePreviewRequestRef.current;
    if (resumeUrlRef.current) {
      URL.revokeObjectURL(resumeUrlRef.current);
      resumeUrlRef.current = null;
    }
    setResumePreview({ kind: 'idle' });
  }

  function handlePreviewResume() {
    if (!profile || !tailoredResume || resumePreview.kind === 'loading') return;
    clearResumePreview();
    setResumePreview({ kind: 'loading' });
    const requestToken = resumePreviewRequestRef.current;
    void httpBackendClient
      .renderResumePdf(profile, tailoredResume)
      .then((bytes) => {
        if (requestToken !== resumePreviewRequestRef.current) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        if (requestToken !== resumePreviewRequestRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        resumeUrlRef.current = url;
        setResumePreview({ kind: 'ready', url });
      })
      .catch(() => {
        if (requestToken === resumePreviewRequestRef.current) {
          setResumePreview({ kind: 'error' });
        }
      });
  }

  const review = reviewOf(run);
  // The pill is suppressed while the panel is still booting — that part genuinely is local state,
  // and a hydrated run shouldn't flash its pill before we know there's a profile to act with.
  // The pill describes the pipeline run, so it's suppressed on the Log tab as well — there is no
  // run there for it to be about.
  const pill =
    status === 'loading' || status === 'no-profile' || tab === 'log' ? null : review.pill;
  const { canReview, outcome } = review;

  return (
    <main className="panel">
      <header className="panel-header">
        <img src={icon48} alt="" className="brand-mark" />
        <h1>djobi</h1>
        {pill && (
          <span className={`status-pill ${pill.tone}`} role="status" aria-live="polite">
            {pill.label}
          </span>
        )}
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      {profileLoaded && profile && (
        <nav className="panel-tabs" aria-label="Panel sections">
          <button
            type="button"
            className={tab === 'autofill' ? 'panel-tab active' : 'panel-tab'}
            aria-current={tab === 'autofill'}
            onClick={() => setTab('autofill')}
          >
            Autofill
          </button>
          <button
            type="button"
            className={tab === 'log' ? 'panel-tab active' : 'panel-tab'}
            aria-current={tab === 'log'}
            onClick={() => setTab('log')}
          >
            Log
          </button>
        </nav>
      )}

      {/*
        Both panes stay mounted and are hidden rather than unmounted. Extracting a posting on the Log
        tab is a model call, and switching to Autofill to glance at the run used to throw the result
        away — the panel's promise is that nothing in flight is lost by looking somewhere else.
      */}
      <div className="panel-body" hidden={tab !== 'log'}>
        {profile && <LogApplication profile={profile} activeTabUrl={tabUrl} />}
      </div>

      <div className="panel-body" hidden={tab !== 'autofill'}>
        {status === 'loading' && (
          <div className="state" role="status" aria-live="polite">
            <span className="spinner" />
            <p>Loading…</p>
          </div>
        )}

        {status === 'profile-error' && (
          <div className="state error" role="alert">
            <span className="state-icon error">⚠️</span>
            <p>Couldn't load your profile. Check that the djobi backend is running, then retry.</p>
            <button type="button" className="btn-primary" onClick={loadProfile}>
              Retry loading profile
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Open profile settings
            </button>
          </div>
        )}

        {status === 'no-profile' && (
          <div className="state" role="status">
            <span className="state-icon">👤</span>
            <p>Set up your profile to get started.</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => chrome.runtime.openOptionsPage()}
            >
              Open profile settings
            </button>
          </div>
        )}

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
                ? 'Paste the job description below, then analyze. The form on this page has been detected and will be filled from what the description says about the role.'
                : 'Paste the job description below to analyze it. You can analyze even though no fillable form has been detected on this page yet — check back before filling.'}
            </p>
            <label className="field-label" htmlFor="job-description">
              Job description
            </label>
            <textarea
              id="job-description"
              className="page-text-input"
              placeholder="Paste the job description here…"
              value={jobDescription}
              onChange={(e) => editJobDescription(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => handleAnalyze()}
              disabled={!jobDescription.trim() || !tabUrl}
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
              {duplicateOf.roleTitle} at {duplicateOf.company}
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
                    value={jobDescription}
                    disabled={status === 'saving'}
                    onChange={(e) => editJobDescription(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleAnalyze()}
                    disabled={!jobDescription.trim() || status === 'saving'}
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
                  onClick={handlePreviewResume}
                  disabled={resumePreview.kind === 'loading'}
                >
                  {resumePreview.kind === 'loading' ? 'Rendering…' : 'Preview tailored resume'}
                </button>
              </div>
              {resumePreview.kind === 'error' && (
                <p className="preview-error" role="alert">
                  Couldn't render the resume preview — try again.
                </p>
              )}
              {resumePreview.kind === 'ready' && (
                <iframe
                  className="resume-preview-frame"
                  src={resumePreview.url}
                  title="Tailored resume"
                />
              )}
            </div>

            {answers.length > 0 && (
              <div className="questions">
                {answers.map((answer) => (
                  <label className="question-card" key={answer.fieldId}>
                    <span>{answer.question}</span>
                    <textarea
                      value={answer.answer}
                      disabled={status === 'saving'}
                      onChange={(e) => updateAnswer(answer.fieldId, e.target.value)}
                    />
                  </label>
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

      {tab === 'autofill' && canReview && jobInfo && tailoredResume && (
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
    </main>
  );
}
