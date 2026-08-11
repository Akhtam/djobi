/**
 * Popup root. Once a profile exists and the active tab is a supported ATS host, polls the
 * background service worker for the job page the content script reported for this tab
 * (`background/jobPageStore.ts`), then runs the extract → tailor/answer pipeline and shows an
 * editable review before filling the page.
 */
import type { JobInfo, Profile, QuestionAnswer, TailoredResume } from '@djobi/shared';
import { useEffect, useState } from 'react';
import { isSupportedAtsHost } from '../lib/atsHosts';
import type { GetJobPageDataMessage, JobPageData } from '../lib/messages';
import { sendMessage } from '../lib/messages';
import { sendToBackground } from '../lib/sendToBackground';
import { AnalysisFailedError, analyzeJobPage, defaultDeps, FillFailedError, fillAndSubmit } from './pipeline';

type Status =
  | 'loading'
  | 'no-profile'
  | 'unsupported-page'
  | 'ready'
  | 'not-detected'
  | 'analyzing'
  | 'analyze-error'
  | 'review'
  | 'filling'
  | 'fill-error'
  | 'filled';

function getJobPageData(tabId: number): Promise<JobPageData | null> {
  return sendMessage<GetJobPageDataMessage, { data: JobPageData | null }>({
    type: 'GET_JOB_PAGE_DATA',
    tabId,
  }).then((response) => response?.data ?? null);
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
      const hostname = tab?.url ? new URL(tab.url).hostname : '';
      if (!isSupportedAtsHost(hostname)) {
        setStatus('unsupported-page');
        return;
      }

      setTabId(tab.id ?? null);
      setTabUrl(tab.url ?? null);
      setStatus('ready');
    });
  }, []);

  useEffect(() => {
    if (status !== 'ready' || tabId === null) return;

    getJobPageData(tabId).then((data) => {
      if (!data) {
        setStatus('not-detected');
        return;
      }
      setJobPageData(data);
      setStatus('analyzing');
    });
  }, [status, tabId]);

  useEffect(() => {
    if (status !== 'analyzing' || !jobPageData || !profile) return;
    alert(`jpd- ${jobPageData},,, profile -${profile}`)
    analyzeJobPage(jobPageData, profile, defaultDeps)
      .then(({ jobInfo: analyzedJobInfo, tailoredResume: resume, answers: draftedAnswers }) => {
        setJobInfo(analyzedJobInfo);
        setTailoredResume(resume);
        setAnswers(draftedAnswers);
        setStatus('review');
      })
      .catch((error: unknown) => {
        if (error instanceof AnalysisFailedError) setStatus('analyze-error');
        else throw error;
      });
  }, [status, jobPageData, profile]);

  function updateAnswer(fieldId: string, value: string) {
    setAnswers((prev) =>
      prev.map((answer) => (answer.fieldId === fieldId ? { ...answer, answer: value } : answer)),
    );
  }

  function handleFill() {
    if (!jobPageData || !profile || !jobInfo || !tailoredResume || tabId === null) return;

    setStatus('filling');

    fillAndSubmit(jobPageData, profile, jobInfo, tailoredResume, answers, tabId, tabUrl, defaultDeps)
      .then(() => setStatus('filled'))
      .catch((error: unknown) => {
        if (error instanceof FillFailedError) setStatus('fill-error');
        else throw error;
      });
  }

  return (
    <main>
      <h1>djobi</h1>
      {status === 'loading' && <p>Loading…</p>}
      {status === 'no-profile' && (
        <>
          <p>Set up your profile to get started.</p>
          <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
            Open profile settings
          </button>
        </>
      )}
      {status === 'unsupported-page' && (
        <p>Navigate to a supported job application page to get started.</p>
      )}
      {status === 'ready' && <p>djobi is ready on this page.</p>}
      {status === 'not-detected' && (
        <>
          <p>Couldn't find an application form on this page yet.</p>
          <button type="button" onClick={() => setStatus('ready')}>
            Try again
          </button>
        </>
      )}
      {status === 'analyzing' && <p>Analyzing job posting…</p>}
      {status === 'analyze-error' && (
        <>
          <p>Something went wrong analyzing this job posting.</p>
          <button type="button" onClick={() => setStatus('analyzing')}>
            Try again
          </button>
        </>
      )}
      {(status === 'review' || status === 'filling' || status === 'fill-error') &&
        jobInfo &&
        tailoredResume && (
          <section>
            <h2>
              {jobInfo.roleTitle} at {jobInfo.company}
            </h2>
            {answers.map((answer) => (
              <label key={answer.fieldId}>
                <span>{answer.question}</span>
                <textarea
                  value={answer.answer}
                  onChange={(e) => updateAnswer(answer.fieldId, e.target.value)}
                />
              </label>
            ))}
            <button type="button" onClick={handleFill} disabled={status === 'filling'}>
              Fill form
            </button>
            {status === 'fill-error' && (
              <>
                <p>Something went wrong filling the form and saving the application.</p>
                <button type="button" onClick={handleFill}>
                  Try again
                </button>
              </>
            )}
          </section>
        )}
      {status === 'filled' && <p>Filled and application saved.</p>}
    </main>
  );
}
