import { withWorkerKeptAlive } from '../lib/keepAlive';
import type { TypedMessage } from '../lib/messages';
import { setJobContext } from '../lib/tabStore/jobContext';
import { patchPipelineRun } from '../lib/tabStore/pipelineRun';
import { recordReport } from './detectedFields';
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
 * Returns the routed task so the service worker can observe terminal rejection. The service-worker
 * listener deliberately does not return this promise to Chrome, and this takes no `sendResponse`,
 * so {@link TypedMessage} remains notification-only and never holds a panel's channel open.
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
export function handleTypedMessage(
  message: TypedMessage,
  sender: chrome.runtime.MessageSender,
  deps: PipelineDeps = productionDeps,
): Promise<void> {
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
      return withWorkerKeptAlive(() =>
        runFill(message.tabId, message.profile, deps, message.expectedRunId),
      );

    case 'START_SAVE_APPLICATION':
      return withWorkerKeptAlive(() =>
        runSaveApplication(message.tabId, deps, message.expectedRunId),
      );

    case 'UPDATE_RUN':
      return patchPipelineRun(message.tabId, message.runId, message.updates).then(() => undefined);

    case 'UPDATE_JOB_CONTEXT':
      return setJobContext(message.tabId, message.tabUrl, message.jobDescription, message.source);

    case 'CHECK_RUN':
      // Nothing to do, deliberately. The work this message asks for has already happened by the
      // time it is routed: `service-worker.ts` runs the recovery sweep before dispatching anything,
      // so simply *arriving* — and starting a worker if none was running — is the whole effect.
      return Promise.resolve();
  }
}
