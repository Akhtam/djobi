/**
 * Background -> content script messaging: the three request/response commands behind
 * {@link PageClient} (hiding the `lastError` handshake and byte encoding), plus the fire-and-forget
 * {@link notifyPage}. The opposite direction is `lib/messages.ts`.
 */
import type { DetectedField, ZodType, ZodTypeOf } from '@djobi/shared';
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
 * What the Fill Step asks the page to do: fields, values, and the resume as raw bytes. Not the wire
 * message (which carries `number[]`, since messaging can't send an `ArrayBuffer`); which upload
 * input gets the file is `content/index.ts`'s choice.
 */
export interface FillPageCommand {
  /** The run being filled, kept by the page so it can name it if the candidate then submits. */
  runId: string;
  fields: DetectedField[];
  values: Record<string, string>;
  resume?: { name: string; type: string; bytes: ArrayBuffer } | undefined;
}

/** The tab-facing half of the Application Pipeline's outside world. */
export interface PageClient {
  /**
   * Fills the form, resolving with the page's account of what landed — or `null` when no frame
   * answered, which doesn't mean nothing was filled. Pass `frameId` when known (see {@link ask}).
   */
  fill(tabId: number, command: FillPageCommand, frameId?: number): Promise<FillFormResult | null>;
  /**
   * Re-scans the tab's live form, or resolves `null` when no frame answers (no content script, no
   * form).
   */
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
  readonly command: ResponseCommand['type'];

  constructor(command: ResponseCommand['type'], detail?: string) {
    super(`${command} returned an invalid response${detail ? `: ${detail}` : ''}`);
    this.name = 'PageResponseError';
    this.command = command;
  }
}

type FrameResponse<Value> =
  | { status: 'unreachable'; frameId?: number | undefined }
  | { status: 'invalid'; frameId?: number | undefined; error: PageResponseError }
  | { status: 'valid'; frameId?: number | undefined; value: Value };

function sendToPage<Schema extends ZodType>(
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
 * Sends one command to a tab and resolves with its reply, or `null` if no frame answered. Reading
 * `chrome.runtime.lastError` marks it handled.
 *
 * **Pass `frameId` when known.** Without it every frame receives the message and the first reply
 * wins — often an invisible third-party iframe answering empty before the form's frame finishes.
 */
function ask<Schema extends ZodType>(
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
 * Broadcasts a fire-and-forget command (only `SHOW_SAVED_TOAST`). Unaddressed: the filled frame may
 * be gone after the submit navigated.
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
 * One sweep's result. An invalid reply rides along instead of throwing, since it's usually an
 * orphaned content script that {@link reconnectContentScripts} can fix; it's raised only if frames
 * still answer badly after reinjection.
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

/**
 * Reinjects content scripts only for the read-only scrape operation. Fill must never be replayed.
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
