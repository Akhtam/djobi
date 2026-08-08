/**
 * Popup root. Once a profile exists and the active tab is a supported ATS host, polls the
 * background service worker for the job page the content script reported for this tab
 * (`background/jobPageStore.ts`), then runs the extract → tailor/answer pipeline and shows an
 * editable review before filling the page.
 */
import type {
  DetectedField,
  FieldCategory,
  JobInfo,
  Profile,
  QuestionAnswer,
  TailoredResume,
} from '@djobi/shared';
import { useEffect, useState } from 'react';
import { isSupportedAtsHost } from '../lib/atsHosts';
import { fetchResumePdf } from '../lib/fetchResumePdf';
import { sendToBackground } from '../lib/sendToBackground';

type Status =
  | 'loading'
  | 'no-profile'
  | 'unsupported-page'
  | 'ready'
  | 'analyzing'
  | 'review'
  | 'filling'
  | 'filled';

interface JobPageData {
  pageText: string;
  fields: DetectedField[];
}

function getJobPageData(tabId: number): Promise<JobPageData | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GET_JOB_PAGE_DATA', tabId },
      (response: { data: JobPageData | null }) => resolve(response?.data ?? null),
    );
  });
}

function sendFillFormMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

/** Maps a scalar (non-question, non-upload) field category to the base profile value that fills it. */
function valueForCategory(category: FieldCategory, profile: Profile): string | undefined {
  switch (category) {
    case 'first_name':
      return profile.fullName.split(' ')[0];
    case 'last_name':
      return profile.fullName.split(' ').slice(1).join(' ') || undefined;
    case 'full_name':
      return profile.fullName;
    case 'email':
      return profile.email;
    case 'phone':
      return profile.phone ?? undefined;
    case 'location':
      return profile.location ?? undefined;
    case 'linkedin_url':
      return profile.links.linkedin ?? undefined;
    case 'portfolio_url':
      return profile.links.portfolio ?? undefined;
    case 'github_url':
      return profile.links.github ?? undefined;
    default:
      return undefined;
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
      if (!data) return;
      setJobPageData(data);
      setStatus('analyzing');
    });
  }, [status, tabId]);

  useEffect(() => {
    if (status !== 'analyzing' || !jobPageData || !profile) return;

    sendToBackground<JobInfo>('/extract-job', { pageText: jobPageData.pageText })
      .then((extractedJobInfo) => {
        setJobInfo(extractedJobInfo);
        const questionFields = jobPageData.fields.filter((field) => field.category === 'question');
        return Promise.all([
          sendToBackground<TailoredResume>('/tailor-resume', {
            profile,
            jobInfo: extractedJobInfo,
          }),
          sendToBackground<QuestionAnswer[]>('/answer-questions', {
            profile,
            jobInfo: extractedJobInfo,
            questions: questionFields.map((field) => ({
              fieldId: field.id,
              question: field.label,
            })),
          }),
        ]);
      })
      .then(([resume, draftedAnswers]) => {
        setTailoredResume(resume);
        setAnswers(draftedAnswers);
        setStatus('review');
      });
  }, [status, jobPageData, profile]);

  function updateAnswer(fieldId: string, value: string) {
    setAnswers((prev) =>
      prev.map((answer) => (answer.fieldId === fieldId ? { ...answer, answer: value } : answer)),
    );
  }

  async function handleFill() {
    if (!jobPageData || !profile || !jobInfo || !tailoredResume || tabId === null) return;

    setStatus('filling');

    const values: Record<string, string> = {};
    for (const field of jobPageData.fields) {
      if (field.category === 'question') {
        const answer = answers.find((a) => a.fieldId === field.id);
        if (answer) values[field.id] = answer.answer;
        continue;
      }
      const value = valueForCategory(field.category, profile);
      if (value !== undefined) values[field.id] = value;
    }

    const resumeUploadField = jobPageData.fields.find(
      (field) => field.category === 'resume_upload',
    );
    let resumeFile: { name: string; type: string; bytes: number[] } | undefined;
    if (resumeUploadField) {
      const pdfBytes = await fetchResumePdf(profile, tailoredResume);
      resumeFile = {
        name: 'resume.pdf',
        type: 'application/pdf',
        bytes: Array.from(new Uint8Array(pdfBytes)),
      };
    }

    await sendFillFormMessage({
      type: 'FILL_FORM',
      tabId,
      fields: jobPageData.fields,
      values,
      resumeFile,
    });

    await sendToBackground('/applications', {
      company: jobInfo.company,
      roleTitle: jobInfo.roleTitle,
      jobUrl: tabUrl ?? '',
      jobInfo,
      tailoredResume,
      answers,
      status: 'draft',
    });

    setStatus('filled');
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
      {status === 'analyzing' && <p>Analyzing job posting…</p>}
      {(status === 'review' || status === 'filling') && jobInfo && tailoredResume && (
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
        </section>
      )}
      {status === 'filled' && <p>Filled and application saved.</p>}
    </main>
  );
}
