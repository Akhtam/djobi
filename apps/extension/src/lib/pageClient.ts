/**
 * Talking to a tab's content script: the three request/response messages the extension waits on,
 * and the transport rules they have to obey. {@link notifyPage} is the one exception — a
 * fire-and-forget broadcast with no response to wait on, the page-facing counterpart of
 * `lib/messages.ts`'s `notify()` — kept here rather than there because every other message to a
 * content script already is.
 *
 * The request/response three live behind an interface because they're the half of the Application
 * Pipeline's outside world that has real behaviour to hide — the `chrome.runtime.lastError`
 * handshake and the `ArrayBuffer` encoding below are both easy to get wrong and invisible when you
 * do. They used to sit inline in a default-parameter object in `background/applicationPipeline.ts`,
 * which meant the only way to exercise them was to run the whole pipeline.
 *
 * Deliberately separate from the coordination protocol in `lib/messages.ts`: that module is
 * panel/content-script -> background; everything here is background -> content script.
 */
import type { DetectedField, ZodTypeAny, ZodTypeOf } from '@djobi/shared';
import {
  FillFormResultSchema,
  JobPageDataSchema,
  ScrapeJobDescriptionResponseSchema,
  type FillFormResult,
  type JobPageData,
  type ScrapedJobDescription,
} from './messages';
import { autofillSource } from './fieldDisposition';
import type {
  FillFormCommandMessage,
  ScanPageCommandMessage,
  ScrapeJobDescriptionCommandMessage,
  ShowSavedToastCommandMessage,
} from './messages';

/**
 * What the Fill Step asks the page to do, in the pipeline's own terms: the fields, the values to
 * write, and the resume to attach as raw bytes.
 *
 * Deliberately not the `FILL_FORM` wire message. That message carries its bytes as `number[]`,
 * because `chrome.runtime` messaging can't carry an `ArrayBuffer` — a transport detail that has no
 * business in the step deciding *what* to fill. Naming which upload input receives the file is
 * likewise absent: `content/index.ts` owns that choice, being the only side that can see the page.
 */
export interface FillPageCommand {
  /** The run being filled, kept by the page so it can name it if the candidate then submits. */
  runId: string;
  fields: DetectedField[];
  values: Record<string, string>;
  resume?: { name: string; type: string; bytes: ArrayBuffer };
}

/** The tab-facing half of the Application Pipeline's outside world. */
export interface PageClient {
  /**
   * Fills the tab's form, resolving with the page's own account of what landed — or `null` when no
   * frame answers (no content script, or a content script orphaned by an extension reload), which
   * the caller must not read as "nothing was filled".
   *
   * `frameId` addresses the frame known to hold the form. Omitting it broadcasts to every frame and
   * takes whichever answers first — see {@link ask}.
   */
  fill(tabId: number, command: FillPageCommand, frameId?: number): Promise<FillFormResult | null>;
  /** Re-scans the tab's live form, or resolves `null` when no frame answers (no content script, no form). */
  scan(tabId: number, frameId?: number): Promise<JobPageData | null>;
  /** Reads every addressable frame and returns the strongest posting found across them. */
  readPosting(tabId: number): Promise<PostingReadOutcome>;
}

export type PostingReadOutcome =
  | { status: 'success'; candidate: ScrapedJobDescription }
  | { status: 'not-found' }
  | { status: 'unavailable' };

type ResponseCommand =
  FillFormCommandMessage | ScanPageCommandMessage | ScrapeJobDescriptionCommandMessage;

/** A content-script reply arrived but did not match the command's response contract. */
export class PageResponseError extends Error {
  constructor(
    readonly command: ResponseCommand['type'],
    detail?: string,
  ) {
    super(`${command} returned an invalid response${detail ? `: ${detail}` : ''}`);
    this.name = 'PageResponseError';
  }
}

type FrameResponse<Value> =
  | { status: 'unreachable'; frameId?: number }
  | { status: 'invalid'; frameId?: number; error: PageResponseError }
  | { status: 'valid'; frameId?: number; value: Value };

function sendToPage<Schema extends ZodTypeAny>(
  tabId: number,
  message: ResponseCommand,
  schema: Schema,
  frameId?: number,
): Promise<FrameResponse<ZodTypeOf<Schema>>> {
  return new Promise((resolve) => {
    const handle = (response?: unknown): void => {
      const error = chrome.runtime.lastError;
      if (error || response == null) {
        resolve({ status: 'unreachable', frameId });
        return;
      }
      const parsed = schema.safeParse(response);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'response'} - ${issue.message}`)
          .join('; ');
        resolve({
          status: 'invalid',
          frameId,
          error: new PageResponseError(message.type, detail),
        });
        return;
      }
      resolve({ status: 'valid', frameId, value: parsed.data as ZodTypeOf<Schema> });
    };

    if (frameId === undefined) chrome.tabs.sendMessage(tabId, message, handle);
    else chrome.tabs.sendMessage(tabId, message, { frameId }, handle);
  });
}

/**
 * Sends one command to a tab and resolves with its reply, or `null` if no frame answered.
 *
 * Reading `chrome.runtime.lastError` is what marks it handled. An unanswered message — no content
 * script in the tab, or no frame holding a form — would otherwise log as an unchecked runtime
 * error, so this is not optional even though nothing reads the value.
 *
 * **Pass `frameId` whenever it is known.** Without it `chrome.tabs.sendMessage` delivers to every
 * frame in the tab and resolves with whichever calls `sendResponse` first, dropping the rest — and
 * the content script is injected into all frames (`manifest.ts`, `all_frames: true`), third-party
 * ones included. An invisible hCaptcha iframe answers instantly with an empty result while the
 * frame that actually owns the form is still waiting out its verification settle, so the fast,
 * wrong answer wins deterministically. The two-argument form remains for the case where no frame
 * has reported yet and there is genuinely nobody to address.
 */
function ask<Schema extends ZodTypeAny>(
  tabId: number,
  message: FillFormCommandMessage | ScanPageCommandMessage,
  schema: Schema,
  frameId?: number,
): Promise<ZodTypeOf<Schema> | null> {
  return sendToPage(tabId, message, schema, frameId).then((response) => {
    if (response.status === 'invalid') throw response.error;
    return response.status === 'valid' ? response.value : null;
  });
}

/**
 * Broadcasts a fire-and-forget command to a tab's content script — the page-facing equivalent of
 * `lib/messages.ts`'s `notify()`. Not addressed to a frame: `SHOW_SAVED_TOAST`, its only caller, is
 * sent after a submission that has usually already navigated the tab, so the frame that was filled
 * may no longer exist and the top frame is as good a place as any to show it.
 *
 * Reading `chrome.runtime.lastError` is what marks the callback handled; nothing here reads the
 * value or retries; there is no response to validate.
 */
export function notifyPage(tabId: number, message: ShowSavedToastCommandMessage): void {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
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

/**
 * One sweep's result. `invalidError` rides alongside an `unavailable` outcome rather than being
 * thrown from here, because a frame answering with an unexpected shape is most often a *stale*
 * content script — an orphan left by an extension reload — which is exactly the case
 * {@link reconnectContentScripts} exists to repair. Throwing at the sweep pre-empted that repair
 * and told the candidate to reload the tab instead. {@link PageClient.readPosting} raises it only
 * once reinjection has been tried and the frames still answer with nothing usable.
 */
type ScrapeSweep = { outcome: PostingReadOutcome; invalidError?: PageResponseError };

async function scrapeFrames(tabId: number, frameIds: number[]): Promise<ScrapeSweep> {
  const message: ScrapeJobDescriptionCommandMessage = { type: 'SCRAPE_JOB_DESCRIPTION' };
  const results = await Promise.all(
    frameIds.map((frameId) =>
      sendToPage(tabId, message, ScrapeJobDescriptionResponseSchema, frameId),
    ),
  );
  const candidates = results
    .flatMap((result) =>
      result.status === 'valid' && result.value.candidate
        ? [{ frameId: result.frameId ?? 0, candidate: result.value.candidate }]
        : [],
    )
    .sort(
      (first, second) =>
        second.candidate.score - first.candidate.score ||
        Number(first.frameId !== 0) - Number(second.frameId !== 0),
    );

  if (candidates[0]) return { outcome: { status: 'success', candidate: candidates[0].candidate } };
  if (results.some((result) => result.status === 'valid'))
    return { outcome: { status: 'not-found' } };
  const invalid = results.find((result) => result.status === 'invalid');
  return {
    outcome: { status: 'unavailable' },
    ...(invalid?.status === 'invalid' ? { invalidError: invalid.error } : {}),
  };
}

/** Reinjects content scripts only for the read-only scrape operation. Fill must never be replayed. */
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
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files }, () =>
      resolve(!chrome.runtime.lastError),
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The production adapter: the tab's own content script. */
export const chromePageClient: PageClient = {
  async fill(tabId, command, frameId) {
    const message: FillFormCommandMessage = {
      type: 'FILL_FORM',
      runId: command.runId,
      fields: command.fields,
      values: command.values,
      // The wire can only carry plain JSON, so the bytes are encoded here, at the edge that
      // actually has the constraint.
      resumeFile: command.resume && {
        name: command.resume.name,
        type: command.resume.type,
        bytes: Array.from(new Uint8Array(command.resume.bytes)),
      },
    };
    const result = await ask(tabId, message, FillFormResultSchema, frameId);
    if (!result) return null;

    const requestedFieldIds = new Set(Object.keys(command.values));
    if (command.resume) {
      for (const field of command.fields) {
        if (autofillSource(field.category) === 'resume') requestedFieldIds.add(field.id);
      }
    }
    const unexpectedFieldId = result.filledFieldIds.find((id) => !requestedFieldIds.has(id));
    if (unexpectedFieldId) {
      throw new PageResponseError('FILL_FORM', `reported unrequested field ${unexpectedFieldId}`);
    }
    if (result.resumeAttached && !command.resume) {
      throw new PageResponseError('FILL_FORM', 'reported an attachment when no resume was sent');
    }

    return result;
  },

  scan(tabId, frameId) {
    const message: ScanPageCommandMessage = { type: 'SCAN_PAGE' };
    return ask(tabId, message, JobPageDataSchema, frameId);
  },

  async readPosting(tabId) {
    const frameIds = await frameIdsForTab(tabId);
    let sweep = await scrapeFrames(tabId, frameIds);
    // An invalid reply counts as unavailable here, the same as silence: both describe frames this
    // build cannot talk to, and both are repaired by the same reinjection. See {@link ScrapeSweep}.
    if (sweep.outcome.status !== 'unavailable' || !(await reconnectContentScripts(tabId))) {
      if (sweep.invalidError) throw sweep.invalidError;
      return sweep.outcome;
    }

    // CRXJS's manifest entry is a loader whose dynamic import finishes just after reinjection.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(100);
      sweep = await scrapeFrames(tabId, frameIds);
      if (sweep.outcome.status !== 'unavailable') return sweep.outcome;
    }
    // Still nothing usable after reinjection. A malformed reply is now the more informative answer
    // than a bare `unavailable`: the frames are reachable and disagree with this build's contract.
    if (sweep.invalidError) throw sweep.invalidError;
    return sweep.outcome;
  },
};
