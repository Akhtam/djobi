/**
 * One tab's Detected Fields, from the content script's first report to the snapshot a run is
 * analyzed against.
 *
 * That lifecycle used to be reconstructed by whoever needed part of it. `background/router.ts`
 * bumped a frame's revision and then fired an API-oracle fetch it did not wait for;
 * `lib/tabStore/detectedPage.ts` held the revisions, the stale-enrichment guard and the best-frame
 * rule; `background/apiDetectors.ts` knew how to carry enrichment onto a later scan; and
 * `background/applicationPipeline.ts` took the snapshot. No module knew the whole sequence, so
 * nothing was in a position to notice that its two ends disagreed about *when* fields are ready.
 *
 * They disagreed like this. Enrichment is asynchronous — the oracle is an HTTP call to the ATS — and
 * the Analysis Step read the frame store the moment the candidate clicked Analyze. Click before the
 * oracle answered and the run was analyzed against DOM-only fields: no API `required` flags, and no
 * API wording for a combobox's choices. Question Answers were then drafted against choices the
 * backend never saw, and the Fill Step, which carries enrichment forward from the run's own
 * snapshot, had nothing to carry. The enriched fields were sitting in storage the whole time.
 *
 * The fix is a snapshot that knows whether the fields are finished, which is what
 * {@link snapshotForRun} is. It is deliberately *not* "have the Fill Step read the fresher store
 * instead": the answers were drafted against the analyzed run's labels, so that snapshot is by
 * definition the right thing to match them against, and swapping in different wording at fill time
 * would break the match and report the field as unresolved. See `carryEnrichment` in
 * `background/apiDetectors.ts`, which makes the same argument from the other side.
 *
 * `lib/tabStore/detectedPage.ts` keeps the storage primitives underneath this — the per-frame
 * revision, the atomic write (`tabStore/record.ts`), the best-frame choice. Deleting them would
 * only move that complexity into callers. What was missing was a module *above* them that owns the
 * order things happen in.
 */
import type { DetectedField } from '@djobi/shared';
import type { JobPageData } from '../lib/messages';
import {
  type DetectedFrameRef,
  enrichDetectedFields,
  getDetectedFrame,
  getDetectedPage,
  reportDetectedPage,
} from '../lib/tabStore/detectedPage';
import { enrichWithApiOracle } from './apiDetectors';

/**
 * The re-scan merge, under the name the rest of the pipeline knows it by.
 *
 * The implementation stays in `background/apiDetectors.ts` because it is that module's `applyPatches`
 * with the earlier scan standing in for the oracle, and pulling it out would mean exporting three
 * label-matching internals to move one function — widening one seam to narrow another. What belongs
 * here is the *interface*: a caller working with a tab's Detected Fields now learns one module name
 * for the whole lifecycle instead of importing the middle of the oracle's.
 */
export { carryEnrichment as mergeRescan } from './apiDetectors';

/**
 * How long {@link snapshotForRun} will wait for an oracle that hasn't answered.
 *
 * Bounded because the wait is on a fetch to a third party: `enrichWithApiOracle` has no timeout of
 * its own, so an ATS host that accepts a connection and then stalls would otherwise hang Analyze
 * indefinitely — trading a degraded analysis for no analysis at all. Long enough for a normal
 * response, short enough that the candidate reads it as the click taking effect.
 *
 * Proceeding on baseline fields when it expires is the same judgement `apiDetectors.ts` already
 * makes for a failed fetch or an unparseable body: enrichment improves an analysis, and must never
 * be the reason there isn't one.
 */
const ENRICHMENT_WAIT_MS = 3_000;

/**
 * The reports still settling, per tab — from the storage write through the oracle call after it.
 *
 * **In memory, never persisted, and that is the point.** A "pending" marker written into
 * `chrome.storage.session` would outlive the worker that was waiting on it — MV3 evicts one after
 * ~30s idle, and it can be evicted mid-fetch — leaving a flag no one will ever clear and an Analysis
 * Step that waits the full timeout on every subsequent run. An empty map after an eviction says
 * exactly the right thing: whatever was in flight died with the worker, and nothing is coming.
 *
 * Keyed by tab and holding a set, because the content script runs in every frame and an ATS form
 * and its host page report at nearly the same instant. A run is analyzed against whichever frame
 * detected the most fields, and which one that is isn't known until they have all settled.
 */
const inFlight = new Map<number, Set<Promise<void>>>();

/** Registers `work` as an in-flight enrichment for `tabId`, clearing it however it settles. */
function track(tabId: number, work: Promise<void>): Promise<void> {
  const forTab = inFlight.get(tabId) ?? new Set<Promise<void>>();
  inFlight.set(tabId, forTab);

  const tracked = work.finally(() => {
    forTab.delete(tracked);
    // Drop the tab's entry once it empties, so a browser session's worth of closed tabs can't
    // accumulate here the way the pre-`tabStore` detection `Map` did.
    if (forTab.size === 0) inFlight.delete(tabId);
  });

  forTab.add(tracked);
  return tracked;
}

/**
 * Waits for this tab's in-flight reports, or for `waitMs`, whichever comes first.
 *
 * Re-reads the registry each pass rather than racing one snapshot of it. A form mounts in pieces and
 * the content script re-reports as it does, so a report can be registered *while* this is already
 * waiting on an earlier one — and returning at that point takes the snapshot with the newer one
 * still outstanding, which is precisely the failure this module exists to prevent. One deadline
 * spans the whole loop, so a stream of reports still cannot extend the bounded wait.
 */
async function settled(tabId: number, waitMs: number): Promise<void> {
  let expire: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<void>((resolve) => {
    expire = setTimeout(() => {
      expired = true;
      resolve();
    }, waitMs);
  });

  try {
    for (let forTab = inFlight.get(tabId); forTab?.size && !expired; forTab = inFlight.get(tabId)) {
      // `allSettled`: a rejected enrichment is a fine reason to stop waiting, and its own handler
      // has already dealt with it. Racing `all` would reject this instead.
      await Promise.race([Promise.allSettled([...forTab]), deadline]);
    }
  } finally {
    clearTimeout(expire);
  }
}

/** Stores one frame's detection, then upgrades it with whatever the platform's API knows. */
async function storeAndEnrich(
  tabId: number,
  frameId: number,
  fields: DetectedField[],
  url: string | undefined,
): Promise<void> {
  const revision = await reportDetectedPage(tabId, frameId, { fields });
  if (!url) return;

  const enriched = await enrichWithApiOracle(url, fields);
  // `enrichDetectedFields` drops this if the frame has been re-reported since `revision`, so a slow
  // response for a page we've navigated away from can't land on top of fresher detection.
  await enrichDetectedFields(tabId, frameId, revision, enriched);
}

/**
 * Records what one frame detected, then upgrades it with whatever the platform's API knows.
 *
 * The returned promise covers both halves, so `background/service-worker.ts` sees a terminal
 * rejection from either. It is not what makes the fields *usable*: the DOM-only fields are stored
 * and readable as soon as the write lands, and the oracle only ever adds to them.
 *
 * Registered as in-flight *before* the write rather than after it, because {@link snapshotForRun}
 * waits on that registry: a report whose storage write hasn't resolved yet is as invisible to the
 * wait as one whose oracle call hasn't, and a run starting in that window is analyzed against a
 * frame this report was in the middle of replacing.
 *
 * `url` is the *reporting document's* URL, not the tab's — see `background/router.ts`, which has the
 * `sender` to tell them apart and the reason it matters.
 */
export function recordReport(
  tabId: number,
  frameId: number,
  fields: DetectedField[],
  url: string | undefined,
): Promise<void> {
  return track(tabId, storeAndEnrich(tabId, frameId, fields, url));
}

/**
 * The tab's detected form, as a run should be analyzed against it: enriched, if enrichment is on its
 * way and arrives in time.
 *
 * This is the one read that waits. The Analysis Step's snapshot is the point of no return for a
 * run's field wording — every Question Answer is drafted against it and the Fill Step matches back
 * to it — so it is worth a bounded pause, where no other read is.
 *
 * Returns an empty form rather than `null` for a tab nothing has reported: a run analyzed from a
 * pasted Job Description before the form rendered has no fields, and that is a normal run, not a
 * missing one.
 *
 * @param waitMs - Overridable so tests don't spend {@link ENRICHMENT_WAIT_MS} proving the timeout.
 */
export async function snapshotForRun(
  tabId: number,
  waitMs: number = ENRICHMENT_WAIT_MS,
): Promise<JobPageData> {
  await settled(tabId, waitMs);
  return (await getDetectedPage(tabId)) ?? { fields: [] };
}

/**
 * The frame holding this tab's form, for the Fill Step to address its commands to.
 *
 * Deliberately does *not* wait on enrichment, unlike {@link snapshotForRun}. The Fill Step re-scans
 * the live page and carries wording forward from the run it is filling, so a fresher enrichment in
 * the store would be the wrong wording to fill with even if it arrived — all this needs from the
 * store is which frame to talk to, and that is settled by the report itself.
 */
export function frameForFill(tabId: number): Promise<DetectedFrameRef | null> {
  return getDetectedFrame(tabId);
}
