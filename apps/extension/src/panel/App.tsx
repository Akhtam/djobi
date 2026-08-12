/**
 * Review UI root, mounted by `panel/main.tsx` as the side panel's sole content (see
 * `manifest.ts`'s `side_panel.default_path` — there's no popup). Once a profile exists, polls the
 * background service worker for the job page the content script reported for the active tab
 * (`lib/tabStore.ts`) — the content script itself runs on every page and decides
 * whether it's a job application form (see `detect.ts`), not a fixed ATS-host allowlist, since
 * ATS platforms let companies white-label their job board onto their own domain. Once a job page
 * is found, kicks off the extract → tailor/answer pipeline — actually run by
 * `background/pipelineRunner.ts`, not here, so it survives this component unmounting mid-run —
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
import { fetchResumePdf } from '../lib/fetchResumePdf';
import type { JobPageData, StartAnalysisMessage, StartFillMessage } from '../lib/messages';
import { sendMessage } from '../lib/messages';
import {
  getDetectedPage,
  getPipelineRun,
  patchPipelineRun,
  storageKey as tabStorageKey,
  type PipelineFailure,
  type PipelineRunState,
  type PipelineStatus,
  type TabState,
} from '../lib/tabStore';
import { sendToBackground } from '../lib/sendToBackground';

// 'loading'/'no-profile'/'ready' are bootstrap-only, local to this component; the rest is
// `PipelineRunState`'s `PipelineStatus`, checkpointed to `tabStore` as it progresses.
type Status = 'loading' | 'no-profile' | 'ready' | PipelineStatus;

function isPipelineStatus(status: Status): status is PipelineStatus {
  return status !== 'loading' && status !== 'no-profile' && status !== 'ready';
}

/** Header status-pill label/tone for a given {@link Status}, or `null` when no pill should show. */
function statusPill(
  status: Status,
  unresolvedRequiredFieldCount: number,
  filledFieldCount: number,
): { label: string; tone: 'busy' | 'success' | 'error' } | null {
  switch (status) {
    case 'analyzing':
      return { label: 'Analyzing…', tone: 'busy' };
    case 'filling':
      return { label: 'Filling…', tone: 'busy' };
    case 'analyze-error':
    case 'fill-error':
      return { label: 'Error', tone: 'error' };
    case 'filled':
      // A run that wrote nothing is a failure wearing a success status — it reaches 'filled'
      // because every step "succeeded", having been handed no fields to fill.
      if (filledFieldCount === 0) return { label: 'Nothing filled', tone: 'error' };
      return unresolvedRequiredFieldCount > 0
        ? { label: 'Incomplete', tone: 'error' }
        : { label: 'Done', tone: 'success' };
    case 'review':
      return { label: 'Ready to fill', tone: 'success' };
    default:
      return null;
  }
}

export function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [jobPageData, setJobPageData] = useState<JobPageData | null>(null);
  const [jobInfo, setJobInfo] = useState<JobInfo | null>(null);
  const [tailoredResume, setTailoredResume] = useState<TailoredResume | null>(null);
  const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
  const [unresolvedRequiredFields, setUnresolvedRequiredFields] = useState<DetectedField[]>([]);
  const [filledFieldCount, setFilledFieldCount] = useState(0);
  const [failure, setFailure] = useState<PipelineFailure | null>(null);
  const [pageTextOverride, setPageTextOverride] = useState<string | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);

  // On-demand tailored-resume PDF preview (POST /render-resume-pdf via `fetchResumePdf`, shown in
  // an iframe from a blob: URL). Kept out of the persisted `PipelineRunState` — it's a
  // display-only, expensive-to-recompute blob URL that shouldn't survive a panel reopen.
  const [resumePreview, setResumePreview] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' }
  >({ kind: 'idle' });
  const resumeUrlRef = useRef<string | null>(null);

  // The last edits this component persisted, serialized. Without it, applying an incoming run
  // would re-trigger the write-through effect, which would write it straight back out again.
  const lastSyncedEditsRef = useRef<string | null>(null);

  /**
   * Restores whatever `tabStore` has for `newTabId` (a completed/in-progress Analysis
   * Step, edited answers, etc.), or falls back to the bootstrap 'ready' state plus an
   * opportunistic `jobPageData` fetch when nothing's been analyzed for that tab yet. Used both at
   * mount and whenever the tracked tab changes (see the effect below).
   */
  async function hydrateForTab(newTabId: number, newTabUrl: string | null) {
    setTabId(newTabId);
    setTabUrl(newTabUrl);
    setShowPageTextEditor(false);
    clearResumePreview();

    const run = await getPipelineRun(newTabId);
    if (run) {
      lastSyncedEditsRef.current = JSON.stringify({
        answers: run.answers,
        pageTextOverride: run.pageTextOverride,
      });
      setStatus(run.status);
      setJobPageData(run.jobPageData);
      setPageTextOverride(run.pageTextOverride);
      setJobInfo(run.jobInfo);
      setTailoredResume(run.tailoredResume);
      setAnswers(run.answers);
      setUnresolvedRequiredFields(run.unresolvedRequiredFields);
      setFilledFieldCount(run.filledFieldCount);
      setFailure(run.failure);
      return;
    }

    lastSyncedEditsRef.current = null;
    setStatus('ready');
    setJobPageData(null);
    setJobInfo(null);
    setTailoredResume(null);
    setAnswers([]);
    setUnresolvedRequiredFields([]);
    setFilledFieldCount(0);
    setFailure(null);
    setPageTextOverride(null);

    // Opportunistic background pre-fill only — the paste + Analyze screen below is shown
    // immediately regardless of whether this ever finds anything, so a page where detection
    // fails (or hasn't finished yet) never blocks the user from pasting the job description
    // themselves and analyzing.
    const data = await getDetectedPage(newTabId);
    if (data) setJobPageData(data);
  }

  useEffect(() => {
    Promise.all([
      sendToBackground<Profile | null>('/profile', undefined, 'GET'),
      new Promise<chrome.tabs.Tab[]>((resolve) =>
        chrome.tabs.query({ active: true, currentWindow: true }, resolve),
      ),
    ]).then(([loadedProfile, tabs]) => {
      if (!loadedProfile) {
        setStatus('no-profile');
        return;
      }
      setProfile(loadedProfile);

      const tab = tabs[0];
      if (tab.id === undefined) {
        setTabUrl(tab.url ?? null);
        setStatus('ready');
        return;
      }
      void hydrateForTab(tab.id, tab.url ?? null);
    });
  }, []);

  // The panel survives a tab switch (unlike a popup, which is destroyed by one) — without this,
  // it would keep showing the previous tab's review after the user switches away.
  useEffect(() => {
    if (status === 'loading' || status === 'no-profile') return;

    function onActivated(activeInfo: chrome.tabs.OnActivatedInfo) {
      if (activeInfo.tabId === tabId) return;
      chrome.tabs.get(
        activeInfo.tabId,
        (tab) => void hydrateForTab(activeInfo.tabId, tab.url ?? null),
      );
    }

    function onUpdated(updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) {
      if (updatedTabId !== tabId || !changeInfo.url) return;
      void hydrateForTab(updatedTabId, changeInfo.url);
    }

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [status, tabId]);

  // Write-through for the two pieces of the run this panel owns: the answers the user edits and
  // the job description they paste. Everything else — status, Analysis Step results, failure — is
  // written by `background/pipelineRunner.ts`, the authority on the run's progress. Persisting
  // those from here too would let this component's optimistic status land *after* the background's
  // real result and overwrite it, losing a completed analysis.
  useEffect(() => {
    // `lastSyncedEditsRef` is only non-null once a run has actually been read in (hydrate) or
    // arrived (subscribe). Until then this component's `answers` is an empty placeholder rather
    // than anything the user typed, and writing it would erase the answers the Analysis Step just
    // produced.
    if (!isPipelineStatus(status) || tabId === null || lastSyncedEditsRef.current === null) return;

    const edits = { answers, pageTextOverride };
    const serialized = JSON.stringify(edits);
    if (serialized === lastSyncedEditsRef.current) return;
    lastSyncedEditsRef.current = serialized;
    void patchPipelineRun(tabId, edits);
  }, [status, tabId, answers, pageTextOverride]);

  // Keeps this view live as the background service worker (`background/pipelineRunner.ts`)
  // checkpoints Analysis/Fill Step progress into the store. Guarded by the same ref the
  // write-through effect uses, so applying a remote change here doesn't bounce straight back out
  // as a redundant write.
  useEffect(() => {
    if (tabId === null) return;
    const key = tabStorageKey(tabId);

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'session' || !(key in changes)) return;
      const newRun = (changes[key].newValue as TabState | undefined)?.run;
      if (!newRun) return; // no run yet, or the tab's entry was cleared — nothing to reflect here

      lastSyncedEditsRef.current = JSON.stringify({
        answers: newRun.answers,
        pageTextOverride: newRun.pageTextOverride,
      });
      setStatus(newRun.status);
      setJobPageData(newRun.jobPageData);
      setPageTextOverride(newRun.pageTextOverride);
      setJobInfo(newRun.jobInfo);
      setTailoredResume(newRun.tailoredResume);
      setAnswers(newRun.answers);
      setUnresolvedRequiredFields(newRun.unresolvedRequiredFields);
      setFilledFieldCount(newRun.filledFieldCount);
      setFailure(newRun.failure);
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [tabId]);

  // Release the preview's blob: URL when the panel unmounts (the blob outlives the component's
  // state, so without this revoked here it'd leak until the browser reclaims it).
  useEffect(() => {
    return () => {
      if (resumeUrlRef.current) URL.revokeObjectURL(resumeUrlRef.current);
    };
  }, []);

  // Analysis/Fill Step execution itself lives in `background/pipelineRunner.ts`, not here — the
  // panel closing mid-request must not kill it. `START_ANALYSIS`/`START_FILL` fire-and-forget (the
  // background handler doesn't hold the response channel open); progress arrives back via the
  // `chrome.storage.onChanged` subscribe effect above, which is what actually drives `status` past
  // 'analyzing'/'filling'. The optimistic `setStatus` calls below are just for instant UI feedback.

  function handleAnalyze() {
    const pageText = pageTextOverride ?? jobPageData?.pageText ?? '';
    if (!pageText || tabId === null || !profile) return;

    // No job page was ever detected (e.g. detection hasn't finished, or failed) — analyze the
    // pasted text standalone, with no fields to fill later (the user can still review answers;
    // "Fill form" just won't have anything to act on until/unless a real form is detected).
    if (!jobPageData) setJobPageData({ pageText, fields: [] });
    setStatus('analyzing');

    void sendMessage<StartAnalysisMessage, void>({
      type: 'START_ANALYSIS',
      tabId,
      tabUrl,
      profile,
      pageTextOverride,
    });
  }

  function updateAnswer(fieldId: string, value: string) {
    setAnswers((prev) =>
      prev.map((answer) => (answer.fieldId === fieldId ? { ...answer, answer: value } : answer)),
    );
  }

  function handleFill() {
    if (!jobPageData || !profile || !jobInfo || !tailoredResume || tabId === null) return;

    setStatus('filling');

    void sendMessage<StartFillMessage, void>({ type: 'START_FILL', tabId, profile });
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
    void fetchResumePdf(profile, tailoredResume)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        resumeUrlRef.current = url;
        setResumePreview({ kind: 'ready', url });
      })
      .catch(() => setResumePreview({ kind: 'error' }));
  }

  const pill = statusPill(status, unresolvedRequiredFields.length, filledFieldCount);
  // 'filled' is included deliberately: filling a form is rarely the end of the task. The page's own
  // validation may reject a value, a required field may have gone unresolved, or an answer may just
  // read badly once it's sitting in the form — and in every one of those cases the user needs the
  // drafted answers, the job-description editor and the resume preview still in front of them to
  // edit and re-fill. Tearing the review down on success left them with a green check and no way
  // back to the content except re-running the whole Analysis Step.
  const canReview =
    status === 'review' ||
    status === 'filling' ||
    status === 'fill-error' ||
    status === 'filled';

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
                ? 'Review the scraped job description below — paste your own if the page didn\'t scrape cleanly (e.g. a separate "Overview" tab) — then analyze.'
                : 'Paste the job description below to analyze it. You can still analyze even though no fillable form has been detected on this page yet — check back before filling.'}
            </p>
            <textarea
              className="page-text-input"
              placeholder="Paste the job description here…"
              value={pageTextOverride ?? jobPageData?.pageText ?? ''}
              onChange={(e) => setPageTextOverride(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={handleAnalyze}
              disabled={!(pageTextOverride ?? jobPageData?.pageText)}
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
        {status === 'filled' && filledFieldCount === 0 && (
          <div className="state error">
            <span className="state-icon error">⚠️</span>
            <p>
              Nothing was filled — no form fields were detected on this page. The application was
              saved, but you'll need to fill the form yourself. If the form is there, it may have
              finished rendering after the page was scanned; reload the page and try again.
            </p>
          </div>
        )}

        {status === 'filled' && filledFieldCount > 0 && unresolvedRequiredFields.length === 0 && (
          <div className="state success">
            <span className="state-icon success">✅</span>
            <p>
              Filled {filledFieldCount} field{filledFieldCount === 1 ? '' : 's'} and saved the
              application.
            </p>
          </div>
        )}

        {status === 'filled' && filledFieldCount > 0 && unresolvedRequiredFields.length > 0 && (
          <div className="state error">
            <span className="state-icon error">⚠️</span>
            <p>
              Filled and application saved, but {unresolvedRequiredFields.length} required field
              {unresolvedRequiredFields.length === 1 ? '' : 's'} couldn't be resolved — check before
              submitting:
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
                    Wrong job title, company, or missing context? Paste the job description here
                    (e.g. from an "Overview" tab the form-scraper didn't see) and re-analyze.
                  </p>
                  <textarea
                    className="page-text-input"
                    value={pageTextOverride ?? jobPageData.pageText}
                    onChange={(e) => setPageTextOverride(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleAnalyze}
                    disabled={!(pageTextOverride ?? jobPageData.pageText)}
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
