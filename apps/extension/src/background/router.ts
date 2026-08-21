import { parseDetectedFields } from '@djobi/shared';
import type { TypedMessage } from '../lib/messages';
import {
  enrichDetectedFields,
  patchPipelineRun,
  reportDetectedPage,
  setJobContext,
} from '../lib/tabStore';
import { enrichWithApiOracle } from './apiDetectors';
import {
  productionDeps,
  runAnalysis,
  runFill,
  runSaveApplication,
  type PipelineDeps,
} from './applicationPipeline';

/**
 * Routes a coordination message, using `lib/tabStore.ts` as the hand-off point.
 *
 * Returns nothing, and takes no `sendResponse`: {@link TypedMessage} is notification-only, and the
 * sender is not waiting. Every branch here is fire-and-forget by design — see the note on
 * `TypedMessage` for why holding the channel open is the failure mode rather than the feature.
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
): void {
  switch (message.type) {
    case 'REPORT_JOB_PAGE': {
      const tabId = sender.tab?.id;
      // `frameId` is 0 for the main frame; the content script runs in every frame, so an ATS form
      // in an iframe and its host page are recorded separately rather than overwriting each other.
      const frameId = sender.frameId ?? 0;
      if (tabId === undefined) return;

      // Parsed, not trusted. A content script keeps running against the build that injected it, so
      // after an extension reload a tab left open reports the field shape *that* build produced.
      // `content/index.ts` already handles the send side of this case; this is the receive side.
      const fields = parseDetectedFields(message.fields);
      const data = { fields };
      // The *sending document's* URL, not the tab's. These differ in the case that matters: an ATS
      // form is usually an iframe on a company's own careers domain, so `sender.tab.url` is
      // `careers.acme.com` while the form — and the posting id every oracle parses out of it — is at
      // `job-boards.greenhouse.io`. Handing the oracle the tab's URL meant it recognized no platform
      // and never fetched, in exactly the case enrichment exists to serve. That failure is
      // indistinguishable from "no oracle matched" by design (see `apiDetectors.ts`), which is why
      // it went unnoticed. Falls back to the tab for a main-frame form, where the two are the same.
      const url = sender.url ?? sender.tab?.url;

      void reportDetectedPage(tabId, frameId, data).then((reportedAt) => {
        if (!url) return;
        // Fire-and-forget: the DOM-only fields are already stored and usable above. This only
        // upgrades them (e.g. filling in a portal-mounted combobox's choices) once the platform API
        // answers — and `enrichDetectedFields` drops the result if this frame has been re-reported
        // in the meantime, so a slow response for a page we've navigated away from can't land on
        // top of fresher detection.
        void enrichWithApiOracle(url, fields).then((enriched) =>
          enrichDetectedFields(tabId, frameId, reportedAt, enriched),
        );
      });
      return;
    }

    case 'START_ANALYSIS':
      // `runAnalysis` checkpoints progress into `tabStore` itself, so the panel reads results from
      // there rather than from a reply it would have to stay open to receive.
      void runAnalysis(
        message.tabId,
        message.tabUrl,
        message.profile,
        message.jobDescription,
        deps,
        message.force,
      );
      return;

    case 'START_FILL':
      void runFill(message.tabId, message.profile, deps);
      return;

    case 'START_SAVE_APPLICATION':
      void runSaveApplication(message.tabId, deps);
      return;

    case 'UPDATE_RUN':
      void patchPipelineRun(message.tabId, message.runId, message.updates);
      return;

    case 'UPDATE_JOB_CONTEXT':
      void setJobContext(message.tabId, message.tabUrl, message.jobDescription, message.source);
      return;
  }
}
