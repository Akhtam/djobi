/**
 * Review UI root, mounted by `panel/main.tsx` as the side panel's sole content (see
 * `manifest.ts`'s `side_panel.default_path` — there's no popup). Once a profile exists, polls the
 * background service worker for the job page the content script reported for the active tab
 * (`lib/tabStore.ts`) — the content script itself runs on every page and decides
 * whether it's a job application form (see `detect.ts`), not a fixed ATS-host allowlist, since
 * ATS platforms let companies white-label their job board onto their own domain. Once a job page
 * is found, kicks off the extract → tailor/answer pipeline — actually run by
 * `background/applicationPipeline.ts`, not here, so it survives this component unmounting mid-run —
 * and shows an editable review, hydrated from and checkpointed to `lib/tabStore.ts`, once
 * results land.
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
import { callBackend, callBackendBinary } from '../lib/callBackend';
import type { JobPageData } from '../lib/messages';
import { notify } from '../lib/messages';
import { reviewOf } from '../lib/runReview';
import { getDetectedPage, type PipelineStatus } from '../lib/tabStore';
import { useActiveTab } from './useActiveTab';
import { usePipelineRun } from './usePipelineRun';

// 'loading'/'no-profile'/'ready' are bootstrap-only, local to this component; the rest is
// `PipelineRunState`'s `PipelineStatus`, checkpointed to `tabStore` as it progresses.
//
// What the run *means* — the pill, whether the review stays up, how the Fill Step went — is not
// derived here. It is `reviewOf` in `lib/runReview.ts`, one derivation the whole component reads.
type Status = 'loading' | 'no-profile' | 'ready' | PipelineStatus;

export function App() {
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [detectedPage, setDetectedPage] = useState<JobPageData | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);
  // The pasted job description before any run exists — once one does, it lives on the run.
  const [localPageText, setLocalPageText] = useState<string | null>(null);

  // The tracked tab, and everything `chrome.tabs` — the panel survives a tab switch, so it follows.
  const { tabId, tabUrl, changeToken } = useActiveTab(Boolean(profile));

  // The stored run — hydration, the storage subscription, the optimistic status and write-back all
  // live in the hook.
  const { run, status: runStatus, begin, edit } = usePipelineRun(tabId);

  const status: Status = !profileLoaded
    ? 'loading'
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

  // Everything scoped to the page being shown, dropped whenever that page changes — a different
  // tab, or a navigation within one. `useActiveTab` reports both as a bumped `changeToken`, and the
  // run itself is re-read by `usePipelineRun` off the new `tabId`.
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

  useEffect(() => {
    void callBackend<Profile | null>('/profile', undefined, 'GET').then((loadedProfile) => {
      setProfile(loadedProfile);
      setProfileLoaded(true);
    });
  }, []);

  // Release the preview's blob: URL when the panel unmounts (the blob outlives the component's
  // state, so without this revoked here it'd leak until the browser reclaims it).
  useEffect(() => {
    return () => {
      if (resumeUrlRef.current) URL.revokeObjectURL(resumeUrlRef.current);
    };
  }, []);

  // Analysis/Fill Step execution lives in `background/applicationPipeline.ts`, not here — the panel
  // closing mid-request must not kill it. `START_ANALYSIS`/`START_FILL` fire-and-forget (the
  // background handler doesn't hold the response channel open); real progress arrives through
  // `usePipelineRun`'s storage subscription. `begin` is only instant UI feedback until the
  // background writes its own status, and is never persisted — see the ownership note on the hook.

  function handleAnalyze() {
    if (!jobDescription.trim() || tabId === null || !profile) return;

    begin('analyzing');

    notify({
      type: 'START_ANALYSIS',
      tabId,
      tabUrl,
      profile,
      jobDescription,
    });
  }

  function editJobDescription(value: string) {
    if (run) edit({ answers, jobDescription: value });
    else setLocalPageText(value);
  }

  function updateAnswer(fieldId: string, value: string) {
    edit({
      answers: answers.map((answer) =>
        answer.fieldId === fieldId ? { ...answer, answer: value } : answer,
      ),
      jobDescription,
    });
  }

  function handleFill() {
    if (!jobPageData || !profile || !jobInfo || !tailoredResume || tabId === null) return;

    begin('filling');

    notify({ type: 'START_FILL', tabId, profile });
  }

  /** Releases the preview's blob: URL and resets the resume-preview state (used on preview
   *  regeneration and whenever the tracked tab changes, since a URL is meaningless without its blob). */
  function clearResumePreview() {
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
    void callBackendBinary('/render-resume-pdf', { profile, tailoredResume })
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        resumeUrlRef.current = url;
        setResumePreview({ kind: 'ready', url });
      })
      .catch(() => setResumePreview({ kind: 'error' }));
  }

  const review = reviewOf(run);
  // The pill is suppressed while the panel is still booting — that part genuinely is local state,
  // and a hydrated run shouldn't flash its pill before we know there's a profile to act with.
  const pill = status === 'loading' || status === 'no-profile' ? null : review.pill;
  const { canReview, outcome } = review;

  return (
    <main className="panel">
      <header className="panel-header">
        <img src={icon48} alt="" className="brand-mark" />
        <h1>djobi</h1>
        {pill && <span className={`status-pill ${pill.tone}`}>{pill.label}</span>}
      </header>

      <div className="panel-body">
        {status === 'loading' && (
          <div className="state">
            <span className="spinner" />
            <p>Loading…</p>
          </div>
        )}

        {status === 'no-profile' && (
          <div className="state">
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
            <textarea
              className="page-text-input"
              placeholder="Paste the job description here…"
              value={jobDescription}
              onChange={(e) => editJobDescription(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={handleAnalyze}
              disabled={!jobDescription.trim()}
            >
              Analyze
            </button>
          </div>
        )}

        {status === 'analyzing' && (
          <div className="state">
            <span className="spinner" />
            <p>Analyzing job posting…</p>
          </div>
        )}

        {status === 'analyze-error' && (
          <div className="state error">
            <span className="state-icon error">⚠️</span>
            <p>Something went wrong analyzing this job posting.</p>
            {failure && <p className="failure-detail">{failure.message}</p>}
            <button type="button" className="btn-secondary" onClick={handleAnalyze}>
              Try again
            </button>
          </div>
        )}

        {/* The Fill Step's outcome sits above the review, not below it: the review is long, and a
            result the user has to scroll past it to find is a result they won't see. */}
        {outcome === 'nothing-filled' && (
          <div className="state error">
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — no form fields were found on this page, including in a fresh scan
              taken just now. The application was saved, but you'll need to fill the form yourself.
              If the form is visibly there, reload the page and try again: this extension can't
              reach a page that was already open when it was last reloaded.
            </p>
          </div>
        )}

        {outcome === 'complete' && (
          <div className="state success">
            <span className="state-icon success">✅</span>
            <p>
              Filled {filledFieldCount} field{filledFieldCount === 1 ? '' : 's'} and saved the
              application.
            </p>
          </div>
        )}

        {outcome === 'incomplete' && (
          <div className="state error">
            <span className="state-icon error">⚠️</span>
            <p>
              Filled and application saved, but {unresolvedRequiredFields.length} required field
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
                  <textarea
                    className="page-text-input"
                    value={jobDescription}
                    onChange={(e) => editJobDescription(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleAnalyze}
                    disabled={!jobDescription.trim()}
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
                <p className="preview-error">Couldn't render the resume preview — try again.</p>
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
                      onChange={(e) => updateAnswer(answer.fieldId, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            )}

            {status === 'fill-error' && (
              <div className="inline-error">
                <div className="inline-error-body">
                  <p>Something went wrong filling the form and saving the application.</p>
                  {failure && <p className="failure-detail">{failure.message}</p>}
                </div>
                <button type="button" className="btn-secondary" onClick={handleFill}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {canReview && jobInfo && tailoredResume && (
        <footer className="panel-footer">
          <button
            type="button"
            className="btn-primary"
            onClick={handleFill}
            disabled={status === 'filling'}
          >
            {status === 'filling' && <span className="spinner" />}
            {status === 'filled' ? 'Fill form again' : 'Fill form'}
          </button>
        </footer>
      )}
    </main>
  );
}
