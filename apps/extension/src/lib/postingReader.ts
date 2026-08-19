import type {
  ScrapedJobDescription,
  ScrapeJobDescriptionCommandMessage,
  ScrapeJobDescriptionResponse,
} from './messages';

export type PostingReadOutcome =
  | { status: 'success'; candidate: ScrapedJobDescription }
  | { status: 'not-found' }
  | { status: 'unavailable' };

interface FrameScrapeResult {
  frameId: number;
  reached: boolean;
  candidate: ScrapedJobDescription | null;
}

function frameIdsForTab(tabId: number): Promise<number[]> {
  return new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      const error = chrome.runtime.lastError;
      if (error || !frames?.length) {
        resolve([0]);
        return;
      }
      resolve([...new Set(frames.map((frame) => frame.frameId))]);
    });
  });
}

function scrapeFrame(tabId: number, frameId: number): Promise<FrameScrapeResult> {
  return new Promise((resolve) => {
    const message: ScrapeJobDescriptionCommandMessage = { type: 'SCRAPE_JOB_DESCRIPTION' };
    chrome.tabs.sendMessage(
      tabId,
      message,
      { frameId },
      (response?: ScrapeJobDescriptionResponse) => {
        const error = chrome.runtime.lastError;
        resolve({
          frameId,
          reached: !error && response !== undefined,
          candidate: response?.candidate ?? null,
        });
      },
    );
  });
}

function outcomeFrom(results: FrameScrapeResult[]): PostingReadOutcome {
  const candidates = results
    .filter(
      (result): result is typeof result & { candidate: ScrapedJobDescription } =>
        result.candidate !== null,
    )
    .sort(
      (first, second) =>
        second.candidate.score - first.candidate.score ||
        Number(first.frameId !== 0) - Number(second.frameId !== 0),
    );

  if (candidates[0]) return { status: 'success', candidate: candidates[0].candidate };
  return results.some((result) => result.reached)
    ? { status: 'not-found' }
    : { status: 'unavailable' };
}

/**
 * Reconnects a tab that predates the current extension build.
 *
 * Reloading an unpacked extension invalidates content scripts already present in open tabs, and a
 * newly-added command therefore has nobody listening until the page itself is reloaded. Reinject
 * only our own manifest-declared scripts, only after every frame proved unreachable.
 */
function reconnectContentScripts(tabId: number): Promise<boolean> {
  if (!chrome.runtime.getManifest || !chrome.scripting?.executeScript)
    return Promise.resolve(false);

  const files = [
    ...new Set(
      (chrome.runtime.getManifest().content_scripts ?? []).flatMap(
        (contentScript) => contentScript.js ?? [],
      ),
    ),
  ];
  if (files.length === 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        files,
      },
      () => {
        const error = chrome.runtime.lastError;
        resolve(!error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Reads every addressable frame and returns the strongest posting, not whichever frame replies first. */
export async function readPostingFromTab(tabId: number): Promise<PostingReadOutcome> {
  const frameIds = await frameIdsForTab(tabId);
  let results = await Promise.all(frameIds.map((frameId) => scrapeFrame(tabId, frameId)));
  let outcome = outcomeFrom(results);
  if (outcome.status !== 'unavailable' || !(await reconnectContentScripts(tabId))) return outcome;

  // CRXJS's manifest entry is a small loader whose dynamic import finishes just after
  // executeScript's callback. Retry briefly rather than requiring the user to reload the whole tab.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await delay(100);
    results = await Promise.all(frameIds.map((frameId) => scrapeFrame(tabId, frameId)));
    outcome = outcomeFrom(results);
    if (outcome.status !== 'unavailable') return outcome;
  }

  return outcome;
}
