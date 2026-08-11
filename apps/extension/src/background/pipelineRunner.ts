import type { Profile } from '@djobi/shared';
import { fetchResumePdf } from '../lib/fetchResumePdf';
import type { FillFormCommandMessage, JobPageData } from '../lib/messages';
import { getPipelineRun, patchPipelineRun, setPipelineRun } from '../lib/pipelineRunStore';
import {
  AnalysisFailedError,
  analyzeJobPage,
  fillAndSubmit,
  FillFailedError,
  type PipelineDeps,
} from '../panel/pipeline';
import { callBackend } from './callBackend';
import { getJobPageData } from './jobPageStore';

/**
 * Runs the Application Pipeline (`panel/pipeline.ts`'s `analyzeJobPage`/`fillAndSubmit`, unchanged)
 * from the background service worker instead of the panel, so an in-flight Analysis or Fill Step
 * survives the panel that requested it closing mid-run — a panel-driven version would drop the
 * result on the floor in that case, because closing the panel tears down the
 * `chrome.runtime.sendMessage` port a direct `sendToBackground` call would be waiting on. Progress
 * is checkpointed into `lib/pipelineRunStore.ts` as it happens; callers (`panel/App.tsx`) observe
 * it via `chrome.storage.onChanged` rather than a message response.
 */
const backgroundDeps: PipelineDeps = {
  extractJob: (pageText) => callBackend('/extract-job', { pageText }),
  tailorResume: (profile, jobInfo) => callBackend('/tailor-resume', { profile, jobInfo }),
  answerQuestions: (profile, jobInfo, questions) =>
    callBackend('/answer-questions', { profile, jobInfo, questions }),
  fetchResumePdf,
  sendFillFormMessage: (message) => {
    const { tabId, type, fields, values, resumeFile } = message as FillFormCommandMessage & {
      tabId: number;
    };
    return new Promise((resolve) =>
      chrome.tabs.sendMessage(tabId, { type, fields, values, resumeFile }, resolve),
    );
  },
  saveApplication: (payload) => callBackend('/applications', payload),
};

export async function runAnalysis(
  tabId: number,
  tabUrl: string | null,
  profile: Profile,
  pageTextOverride: string | null,
): Promise<void> {
  const detected = getJobPageData(tabId);
  const pageText = pageTextOverride ?? detected?.pageText ?? '';
  if (!pageText) return; // nothing to analyze — mirrors the panel's own guard before sending this

  const jobPageData: JobPageData = detected ? { ...detected, pageText } : { pageText, fields: [] };

  await setPipelineRun(tabId, {
    status: 'analyzing',
    tabUrl,
    jobPageData,
    pageTextOverride,
    jobInfo: null,
    tailoredResume: null,
    answers: [],
    unresolvedRequiredFields: [],
  });

  try {
    const { jobInfo, tailoredResume, answers } = await analyzeJobPage(
      jobPageData,
      profile,
      backgroundDeps,
    );
    await patchPipelineRun(tabId, { status: 'review', jobInfo, tailoredResume, answers });
  } catch (error) {
    if (!(error instanceof AnalysisFailedError)) throw error;
    await patchPipelineRun(tabId, { status: 'analyze-error' });
  }
}

export async function runFill(tabId: number, profile: Profile): Promise<void> {
  const run = await getPipelineRun(tabId);
  if (!run || !run.jobInfo || !run.tailoredResume) return;

  await patchPipelineRun(tabId, { status: 'filling' });

  try {
    const { unresolvedRequiredFields } = await fillAndSubmit(
      run.jobPageData,
      profile,
      run.jobInfo,
      run.tailoredResume,
      run.answers,
      tabId,
      run.tabUrl,
      backgroundDeps,
    );
    await patchPipelineRun(tabId, { status: 'filled', unresolvedRequiredFields });
  } catch (error) {
    if (!(error instanceof FillFailedError)) throw error;
    await patchPipelineRun(tabId, { status: 'fill-error' });
  }
}
