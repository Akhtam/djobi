/**
 * What the content script detected on a tab, per frame.
 *
 * The content script runs in every frame, so a tab holds several detections — typically an ATS
 * iframe with the real form beside a host page with none. Which of them is *the* form, and how a
 * slow API-oracle enrichment lands on the right one, is what this interface is for.
 * `background/detectedFields.ts` owns the order those things happen in; this owns the storage.
 */
import type { DetectedField } from '@djobi/shared';
import type { JobPageData } from '../messages';
import { read, subscribePageRecord, withTabLock, write } from './record';

/** Re-runs `onChange` only when the page-scoped half of the tab record moves. */
export function subscribeDetectedPage(tabId: number, onChange: () => void): () => void {
  return subscribePageRecord(tabId, onChange);
}

/**
 * Records what one frame detected. Returns the new revision to hand back to
 * {@link enrichDetectedFields}, which uses it to detect that it has been superseded.
 */
export async function reportDetectedPage(
  tabId: number,
  frameId: number,
  data: JobPageData,
): Promise<number> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const revision = (state.frames[frameId]?.revision ?? 0) + 1;
    await write(tabId, {
      ...state,
      frames: { ...state.frames, [frameId]: { data, revision } },
    });
    return revision;
  });
}

/**
 * Applies API-oracle-enriched fields to a frame's detection — but only if that frame hasn't been
 * re-reported since revision `revision`. The enrichment is fired off without being awaited, so without
 * this check a result for a page the tab has already navigated away from would land on top of the
 * newer detection.
 */
export async function enrichDetectedFields(
  tabId: number,
  frameId: number,
  revision: number,
  fields: DetectedField[],
): Promise<void> {
  return withTabLock(tabId, async () => {
    const state = await read(tabId);
    const frame = state.frames[frameId];
    if (!frame || frame.revision !== revision) return;

    // Most reports enrich nothing — no oracle recognizes the URL, or the fetch failed — and
    // `enrichWithApiOracle` returns the fields it was given in every one of those cases. Writing
    // them back unchanged still costs a `chrome.storage.session` write, and every write to this key
    // is an event each panel subscriber has to interpret. Doing that twice per report, for no
    // change, is what made the panel's optimistic status so easy to knock over.
    if (JSON.stringify(fields) === JSON.stringify(frame.data.fields)) return;

    await write(tabId, {
      ...state,
      frames: { ...state.frames, [frameId]: { ...frame, data: { ...frame.data, fields } } },
    });
  });
}

/** A detected frame together with the id needed to address it. */
export interface DetectedFrameRef {
  frameId: number;
  data: JobPageData;
}

/**
 * The frame holding the tab's job application form, *and its id* — the frame that detected the most
 * fields. A host page wrapping an ATS iframe often has a stray file input of its own, and picking by
 * field count stops that from shadowing the iframe's real form.
 *
 * The id is the part that matters to the Fill Step. `chrome.tabs.sendMessage` with no `frameId`
 * delivers to *every* frame and resolves with whichever answers first, and the content script runs
 * in all of them — so a third-party iframe (an invisible hCaptcha, a tag-manager pixel) answers
 * `FILL_FORM` with an empty result before the real frame has finished verifying its own writes, and
 * the pipeline reads "nothing landed" no matter what actually happened. Addressing the frame is the
 * fix; `content/index.ts` staying silent in frames that hold none of the fields is the backstop.
 */
export async function getDetectedFrame(tabId: number): Promise<DetectedFrameRef | null> {
  const frames = Object.entries((await read(tabId)).frames);
  if (frames.length === 0) return null;

  const [frameId, frame] = frames.reduce((best, entry) =>
    entry[1].data.fields.length > best[1].data.fields.length ? entry : best,
  );
  // Keys round-trip through JSON as strings; the id has to go back over `chrome.tabs.sendMessage`
  // as the number it started as.
  return { frameId: Number(frameId), data: frame.data };
}

/** The detected form itself, for callers that don't need to address the frame it lives in. */
export async function getDetectedPage(tabId: number): Promise<JobPageData | null> {
  return (await getDetectedFrame(tabId))?.data ?? null;
}
