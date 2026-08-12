import type { Profile } from '@djobi/shared';
import { fetchResumePdf } from '../lib/fetchResumePdf';
import type { FillFormCommandMessage, JobPageData } from '../lib/messages';
import {
  asAnalyzedRun,
  getDetectedPage,
  getPipelineRun,
  patchPipelineRun,
  setPipelineRun,
} from '../lib/tabStore';
import {
  AnalysisFailedError,
  analyzeJobPage,
  fillAndSubmit,
  FillFailedError,
  type PipelineDeps,
} from '../panel/pipeline';
import { callBackend } from './callBackend';

/**
 * Runs the Application Pipeline (`panel/pipeline.ts`'s `analyzeJobPage`/`fillAndSubmit`, unchanged)
 * from the background service worker instead of the panel, so an in-flight Analysis or Fill Step
 * survives the panel that requested it closing mid-run — a panel-driven version would drop the
 * result on the floor in that case, because closing the panel tears down the
 * `chrome.runtime.sendMessage` port a direct `sendToBackground` call would be waiting on. Progress
 * is checkpointed into `lib/tabStore.ts` as it happens; callers (`panel/App.tsx`) observe
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

/**
 * Unwraps the message from an {@link AnalysisFailedError}/{@link FillFailedError}'s `cause` — the
 * layer that actually knows what went wrong (usually a `BackendError` naming the path and status).
 * The wrapper's own message is a fixed string, so reporting it alone tells the user nothing.
 */
function causeMessage(error: { cause?: unknown }): string {
  const { cause } = error;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause ?? 'unknown cause');
}

export async function runAnalysis(
  tabId: number,
  tabUrl: string | null,
  profile: Profile,
  pageTextOverride: string | null,
): Promise<void> {
  const detected = await getDetectedPage(tabId);
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
    filledFieldCount: 0,
    failure: null,
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
    await patchPipelineRun(tabId, {
      status: 'analyze-error',
      failure: { step: 'analysis', message: causeMessage(error) },
    });
  }
}

export async function runFill(tabId: number, profile: Profile): Promise<void> {
  const run = asAnalyzedRun(await getPipelineRun(tabId));
  if (!run) return;

  await patchPipelineRun(tabId, { status: 'filling', failure: null });

  try {
    const { unresolvedRequiredFields, filledFieldCount } = await fillAndSubmit(
      run,
      profile,
      tabId,
      backgroundDeps,
    );
    await patchPipelineRun(tabId, { status: 'filled', unresolvedRequiredFields, filledFieldCount });
  } catch (error) {
    if (!(error instanceof FillFailedError)) throw error;
    await patchPipelineRun(tabId, {
      status: 'fill-error',
      failure: { step: 'fill', message: causeMessage(error) },
    });
  }
}
