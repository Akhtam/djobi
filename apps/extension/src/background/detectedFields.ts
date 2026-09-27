/**
 * One tab's Detected Fields, from the content script's report to the snapshot a run is analyzed
 * against — the module that owns the order things happen in.
 *
 * Enrichment is asynchronous, so an Analyze click right after load could otherwise snapshot
 * DOM-only fields: no API `required` flags or choice wording, and answers drafted against choices
 * the Fill Step can't match. {@link snapshotForRun} waits (bounded) for in-flight enrichment. The
 * Fill Step deliberately doesn't read fresher enrichment; it matches the analyzed wording (see
 * `carryEnrichment`).
 *
 * Storage primitives (per-frame revision, atomic writes, best-frame choice) stay in
 * `lib/tabStore/detectedPage.ts`.
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
 * The re-scan merge. Implemented in `apiDetectors.ts` (it's `applyPatches` with the earlier scan as
 * the oracle); re-exported so callers learn one module for the whole lifecycle.
 */
export { carryEnrichment as mergeRescan } from './apiDetectors';

/**
 * How long {@link snapshotForRun} waits for an oracle. Bounded because `enrichWithApiOracle` has no
 * timeout and a stalled ATS host must not block Analyze; on expiry the baseline fields are used.
 */
const ENRICHMENT_WAIT_MS = 3_000;

/**
 * Reports still settling per tab, from storage write through oracle call.
 *
 * In memory on purpose: a persisted "pending" flag would outlive an evicted worker and make every
 * later run wait out the timeout. A set per tab, since every frame reports and the best frame isn't
 * known until all settle.
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
 * Waits for this tab's in-flight reports or `waitMs`, whichever comes first. Re-reads the registry
 * each pass (forms re-report as they mount) under one overall deadline.
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
 * Records one frame's fields, then enriches them from the platform API. The DOM-only fields are
 * readable once the write lands; the promise covers both halves so the service worker sees any
 * rejection.
 *
 * Registered as in-flight *before* the write, so {@link snapshotForRun} can't miss a report
 * mid-write. `url` is the reporting document's URL, not the tab's (see `background/router.ts`).
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
 * The tab's form as a run should be analyzed against it — the one read that waits for enrichment,
 * since every answer is drafted against this snapshot. An empty form (not `null`) when nothing
 * reported: a run from a pasted description before the form rendered is normal.
 *
 * @param waitMs - Overridable so tests don't wait out {@link ENRICHMENT_WAIT_MS}.
 */
export async function snapshotForRun(
  tabId: number,
  waitMs: number = ENRICHMENT_WAIT_MS,
): Promise<JobPageData> {
  await settled(tabId, waitMs);
  return (await getDetectedPage(tabId)) ?? { fields: [] };
}

/**
 * The frame holding this tab's form, for Fill Step commands. Doesn't wait on enrichment: the fill
 * uses the run's analyzed wording, not fresher enrichment.
 */
export function frameForFill(tabId: number): Promise<DetectedFrameRef | null> {
  return getDetectedFrame(tabId);
}
