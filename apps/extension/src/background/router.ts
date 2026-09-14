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
 * Routes a coordination message, using `lib/tabStore/` as the hand-off point.
 *
 * Returns the routed task so the service worker can observe terminal rejection. Most cases are
 * notification-only: the service-worker listener does not return that promise to Chrome and takes
 * no `sendResponse`, so {@link TypedMessage} never holds a panel's channel open for these. `UPDATE_RUN`,
 * `START_FILL` and `START_SAVE_APPLICATION` are the documented exceptions — each answers something
 * the caller genuinely waits on — and `service-worker.ts` is what actually relays them; this function
 * only has to resolve to the right shape.
 *
 * `START_FILL`/`START_SAVE_APPLICATION` resolve as soon as `background/runClaim.ts` knows whether
 * the claim was won — not when the step finishes. The step itself keeps running underneath, exactly
 * as it did when this was fire-and-forget; the `.catch` below is what replaces the service worker's
 * own top-level one for that detached tail, which this function's returned promise no longer covers
 * once it resolves early. These two therefore never reject: a fault reaching that `.catch` before
 * the claim was decided still resolves with a refusal, since a caller waiting on this promise has no
 * better answer to fall back on than the one a losing claim already reports.
 *
 * What this module genuinely owns, and the reason it isn't just inlined into the service worker, is
 * the frame/revision rule below.
 *
 * `deps` is the Application Pipeline's seam, taken here rather than only by the three functions
 * below it. The pipeline's own adapter substitution stopped one level too low: a caller that wanted
 * a fake backend had to bypass this dispatch and call `runAnalysis`/`runFill`/`runSaveApplication`
 * itself, which is what `panel/panelTestHarness.ts` used to do — re-stating all five cases, with a
 * cast per field, in a switch that could drift from this one without either side failing. Two
 * adapters now meet at one interface: production from `service-worker.ts`, a fake backend and page
 * from the panel tests.
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

      // Already parsed at the service-worker boundary. A content script keeps running against the
      // build that injected it, so the protocol version rejects an old shape after an extension
      // reload before this router sees it.
      // The *sending document's* URL, not the tab's. These differ in the case that matters: an ATS
      // form is usually an iframe on a company's own careers domain, so `sender.tab.url` is
      // `careers.acme.com` while the form — and the posting id every oracle parses out of it — is at
      // `job-boards.greenhouse.io`. Handing the oracle the tab's URL meant it recognized no platform
      // and never fetched, in exactly the case enrichment exists to serve. That failure is
      // indistinguishable from "no oracle matched" by design (see `apiDetectors.ts`), which is why
      // it went unnoticed. Falls back to the tab for a main-frame form, where the two are the same.
      const url = sender.url ?? sender.tab?.url;

      // Storing the report and upgrading it from the platform's API are one sequence, and
      // `background/detectedFields.ts` owns it — including the part this dispatch is in no position
      // to know, that a run started before the oracle answers must wait for it.
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
          // A no-op if `onClaimed` above already settled this promise — a fault reaching here
          // instead means the claim itself was never decided, so there is nothing better to answer
          // with than the same refusal a losing claim reports.
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
      // The candidate pressed the ATS's own Submit on a form this extension filled. Saving is the
      // Save Step exactly as the panel's Save button runs it — including its claim, which will
      // refuse a run that isn't a completed, unsaved fill (`startableFrom('save')`), and its
      // `expectedRunId` check, which refuses a submission belonging to a superseded run.
      const tabId = sender.tab?.id;
      if (tabId === undefined) return Promise.resolve();

      return withWorkerKeptAlive(() => runSaveApplication(tabId, deps, message.runId));
    }

    case 'CHECK_RUN':
      // Nothing to do, deliberately. The work this message asks for has already happened by the
      // time it is routed: `service-worker.ts` runs the recovery sweep before dispatching anything,
      // so simply *arriving* — and starting a worker if none was running — is the whole effect.
      return Promise.resolve();
  }
}
