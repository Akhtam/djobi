import { withWorkerKeptAlive } from '../lib/keepAlive';
import type { ClaimResult, TypedMessage, UpdateRunResult } from '../lib/messages';
import { setJobContext } from '../lib/tabStore/jobContext';
import { applyPanelEdit } from '../lib/tabStore/pipelineRun';
import { recordReport } from './detectedFields';
import { clearSavedBadge } from './saveBadge';
import {
  productionDeps,
  runAnalysis,
  runFill,
  runSaveApplication,
  type PipelineDeps,
} from './applicationPipeline';

/**
 * Routes one coordination message, using `lib/tabStore/` as the hand-off point, and returns the
 * task so the listener can log a terminal rejection.
 *
 * `UPDATE_RUN`, `START_FILL` and `START_SAVE_APPLICATION` resolve with a reply (see
 * `messageListener.ts`). Fill/Save resolve as soon as `runClaim.ts` decides the claim, while the
 * step keeps running; they never reject — a fault before the claim resolves as a refusal.
 *
 * `deps` is the pipeline seam, so tests drive the same dispatch with fakes.
 */
export async function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  deps: PipelineDeps = productionDeps,
): Promise<void | UpdateRunResult | ClaimResult> {
  switch (message.type) {
    case 'REPORT_JOB_PAGE': {
      const tabId = sender.tab?.id;
      // `frameId` is 0 for the main frame; the content script runs in every frame, so an ATS form
      // in an iframe and its host page are recorded separately rather than overwriting each other.
      const frameId = sender.frameId ?? 0;
      if (tabId === undefined) return Promise.resolve();

      // Already parsed and version-checked at the listener, so an orphaned content script's old
      // shape never reaches here. The *sending document's* URL, not the tab's: an ATS form is often
      // an iframe on the company's domain, and oracles parse the posting from the iframe's URL.
      // Falls back to the tab's.
      const url = sender.url ?? sender.tab?.url;

      // `detectedFields.ts` owns store-then-enrich, including making a run wait for the oracle.
      return recordReport(tabId, frameId, message.fields, url);
    }

    case 'START_ANALYSIS':
      // A fresh run is not the saved one the badge was raised for, so the tab's saved marker goes
      // as the run that earned it is replaced.
      void clearSavedBadge(message.tabId);
      // `runAnalysis` checkpoints progress into `tabStore/pipelineRun.ts` itself, so the panel
      // reads results from there rather than from a reply it would have to stay open to receive.
      return withWorkerKeptAlive(() =>
        runAnalysis(
          message.tabId,
          message.tabUrl,
          message.profile,
          message.jobDescription,
          deps,
          message.force,
        ),
      );

    case 'START_FILL':
      return new Promise<ClaimResult>((resolve) => {
        void withWorkerKeptAlive(() =>
          runFill(message.tabId, message.profile, deps, message.expectedRunId, resolve),
        ).catch((error: unknown) => {
          console.error('[djobi] fill step failed', error);
          // No-op if `onClaimed` already settled; otherwise the claim was never decided, so refuse.
          resolve({ claimed: false, reason: 'busy' });
        });
      });

    case 'START_SAVE_APPLICATION':
      return new Promise<ClaimResult>((resolve) => {
        void withWorkerKeptAlive(() =>
          runSaveApplication(message.tabId, deps, message.expectedRunId, resolve),
        ).catch((error: unknown) => {
          console.error('[djobi] save step failed', error);
          resolve({ claimed: false, reason: 'busy' });
        });
      });

    case 'UPDATE_RUN': {
      // The run domain's call, made inside the same lock as the write — see `applyPanelEdit`'s own
      // doc comment for why this can't be a `patchPipelineRun` that always succeeds.
      const { applied } = await applyPanelEdit(message.tabId, message.runId, message.updates);
      return { applied };
    }

    case 'UPDATE_JOB_CONTEXT':
      return setJobContext(message.tabId, message.tabUrl, message.jobDescription, message.source);

    case 'REPORT_SUBMISSION': {
      // The candidate pressed the ATS's own Submit on a form we filled: run the Save Step exactly
      // as the panel does. Its claim refuses runs that aren't completed, unsaved fills, and
      // `expectedRunId` refuses a superseded run.
      const tabId = sender.tab?.id;
      if (tabId === undefined) return Promise.resolve();

      return withWorkerKeptAlive(() => runSaveApplication(tabId, deps, message.runId));
    }

    case 'CHECK_RUN':
      // Nothing to do: arriving wakes the worker, and the recovery sweep runs before any route.
      return Promise.resolve();
  }
}
