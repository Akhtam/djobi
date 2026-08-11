/**
 * Review UI root, mounted by `panel/main.tsx` as the side panel's sole content (see
 * `manifest.ts`'s `side_panel.default_path` — there's no popup). Once a profile exists, polls the
 * background service worker for the job page the content script reported for the active tab
 * (`background/jobPageStore.ts`) — the content script itself runs on every page and decides
 * whether it's a job application form (see `detect.ts`), not a fixed ATS-host allowlist, since
 * ATS platforms let companies white-label their job board onto their own domain. Once a job page
 * is found, kicks off the extract → tailor/answer pipeline — actually run by
 * `background/pipelineRunner.ts`, not here, so it survives this component unmounting mid-run —
 * and shows an editable review, hydrated from and checkpointed to `lib/pipelineRunStore.ts`, once
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
import type {
  GetJobPageDataMessage,
  JobPageData,
  StartAnalysisMessage,
  StartFillMessage,
} from '../lib/messages';
import { sendMessage } from '../lib/messages';
import {
  getPipelineRun,
  setPipelineRun,
  storageKey as pipelineRunStorageKey,
  type PipelineRunState,
  type PipelineStatus,
} from '../lib/pipelineRunStore';
import { sendToBackground } from '../lib/sendToBackground';

// 'loading'/'no-profile'/'ready' are bootstrap-only, local to this component; the rest is
// `PipelineRunState`'s `PipelineStatus`, checkpointed to `pipelineRunStore` as it progresses.
type Status = 'loading' | 'no-profile' | 'ready' | PipelineStatus;

function isPipelineStatus(status: Status): status is PipelineStatus {
  return status !== 'loading' && status !== 'no-profile' && status !== 'ready';
}

function getJobPageData(tabId: number): Promise<JobPageData | null> {
  return sendMessage<GetJobPageDataMessage, { data: JobPageData | null }>({
    type: 'GET_JOB_PAGE_DATA',
    tabId,
  }).then((response) => response?.data ?? null);
}

/** Header status-pill label/tone for a given {@link Status}, or `null` when no pill should show. */
function statusPill(
  status: Status,
  unresolvedRequiredFieldCount: number,
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
  const [pageTextOverride, setPageTextOverride] = useState<string | null>(null);
  const [showPageTextEditor, setShowPageTextEditor] = useState(false);

  // On-demand tailored-resume PDF preview (POST /render-resume-pdf via `fetchResumePdf`, shown in
  // an iframe from a blob: URL). Kept out of the persisted `PipelineRunState` — it's a
  // display-only, expensive-to-recompute blob URL that shouldn't survive a panel reopen.
  const [resumePreview, setResumePreview] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; url: string }
    | { kind: 'error' }
  >({ kind: 'idle' });
  const resumeUrlRef = useRef<string | null>(null);

  // Tracks the last `PipelineRunState` this component either wrote to or read from
  // `pipelineRunStore`, serialized. Lets the write-through effect skip re-persisting a run that
  // only changed by reference (not content) after being applied from a remote update, and lets
  // the storage-subscribe effect skip re-applying a change that's just the echo of this
  // component's own write — without this, the two effects would trigger each other forever.
  const lastSyncedRunRef = useRef<string | null>(null);

  /**
   * Restores whatever `pipelineRunStore` has for `newTabId` (a completed/in-progress Analysis
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
      lastSyncedRunRef.current = JSON.stringify(run);
      setStatus(run.status);
      setJobPageData(run.jobPageData);
      setPageTextOverride(run.pageTextOverride);
      setJobInfo(run.jobInfo);
      setTailoredResume(run.tailoredResume);
      setAnswers(run.answers);
      setUnresolvedRequiredFields(run.unresolvedRequiredFields);
      return;
    }

    lastSyncedRunRef.current = null;
    setStatus('ready');
    setJobPageData(null);
    setJobInfo(null);
    setTailoredResume(null);
    setAnswers([]);
    setUnresolvedRequiredFields([]);
    setPageTextOverride(null);

    // Opportunistic background pre-fill only — the paste + Analyze screen below is shown
    // immediately regardless of whether this ever finds anything, so a page where detection
    // fails (or hasn't finished yet) never blocks the user from pasting the job description
    // themselves and analyzing.
    const data = await getJobPageData(newTabId);
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

  // Write-through: checkpoints Application Pipeline progress into `pipelineRunStore` as it
  // happens, so a closed-and-reopened panel, or one that switched away and back, rehydrates
  // instead of resetting. Only active once a run has actually started (`isPipelineStatus`) — the
  // 'ready' bootstrap state (nothing analyzed yet) isn't durable-worthy.
  useEffect(() => {
    if (!isPipelineStatus(status) || tabId === null || !jobPageData) return;

    const run: PipelineRunState = {
      status,
      tabUrl,
      jobPageData,
      pageTextOverride,
      jobInfo,
      tailoredResume,
      answers,
      unresolvedRequiredFields,
    };
    const serialized = JSON.stringify(run);
    if (serialized === lastSyncedRunRef.current) return;
    lastSyncedRunRef.current = serialized;
    void setPipelineRun(tabId, run);
  }, [
    status,
    tabId,
    tabUrl,
    jobPageData,
    pageTextOverride,
    jobInfo,
    tailoredResume,
    answers,
    unresolvedRequiredFields,
  ]);

  // Keeps this view live as the background service worker (`background/pipelineRunner.ts`)
  // checkpoints Analysis/Fill Step progress into the store. Guarded by the same ref the
  // write-through effect uses, so applying a remote change here doesn't bounce straight back out
  // as a redundant write.
  useEffect(() => {
    if (tabId === null) return;
    const key = pipelineRunStorageKey(tabId);

    function onChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
      if (areaName !== 'session' || !(key in changes)) return;
      const newRun = changes[key].newValue as PipelineRunState | undefined;
      if (!newRun) return; // tab's run was cleared (e.g. the tab closed) — nothing to reflect here

      const serialized = JSON.stringify(newRun);
      if (serialized === lastSyncedRunRef.current) return;
      lastSyncedRunRef.current = serialized;
      setStatus(newRun.status);
      setJobPageData(newRun.jobPageData);
      setPageTextOverride(newRun.pageTextOverride);
      setJobInfo(newRun.jobInfo);
      setTailoredResume(newRun.tailoredResume);
      setAnswers(newRun.answers);
      setUnresolvedRequiredFields(newRun.unresolvedRequiredFields);
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

  const pill = statusPill(status, unresolvedRequiredFields.length);
  const canReview = status === 'review' || status === 'filling' || status === 'fill-error';

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
            <button type="button" className="btn-secondary" onClick={handleAnalyze}>
              Try again
            </button>
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
                  {resumePreview.kind === 'loading'
                    ? 'Rendering…'
                    : 'Preview tailored resume'}
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
                <p>Something went wrong filling the form and saving the application.</p>
                <button type="button" className="btn-secondary" onClick={handleFill}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {status === 'filled' && unresolvedRequiredFields.length === 0 && (
          <div className="state success">
            <span className="state-icon success">✅</span>
            <p>Filled and application saved.</p>
          </div>
        )}

        {status === 'filled' && unresolvedRequiredFields.length > 0 && (
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
            Fill form
          </button>
        </footer>
      )}
    </main>
  );
}
