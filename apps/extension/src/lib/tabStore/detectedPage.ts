/**
 * Storage for what the content script detected on a tab, per frame (it runs in every frame, so a
 * tab typically holds an ATS iframe's form plus a host page with none).
 * `background/detectedFields.ts` owns the order of operations; this owns the storage.
 */
import type { DetectedField } from '@djobi/shared';
import type { JobPageData } from '../messages';
import { read, subscribePageRecord, withTabLock, write } from './record';

/** Re-runs `onChange` only when the page-scoped half of the tab record moves. */
export function subscribeDetectedPage(tabId: number, onChange: () => void): () => void {
  return subscribePageRecord(tabId, onChange);
}

/** Records one frame's detection; returns the new revision for {@link enrichDetectedFields}. */
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
 * Applies enriched fields to a frame only if it hasn't been re-reported since `revision`, so a slow
 * enrichment can't overwrite a newer detection.
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

    // Usually nothing was enriched; skip the no-op write, since every write is a storage event each
    // panel subscriber must interpret.
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
 * The frame holding the tab's form — the one that detected the most fields — and its id.
 *
 * The id matters: without a `frameId`, `chrome.tabs.sendMessage` reaches every frame and takes the
 * first reply, and a third-party iframe (hCaptcha, a pixel) answers `FILL_FORM` empty before the
 * real frame finishes. `content/index.ts` staying silent in frames without the fields is the
 * backstop.
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
