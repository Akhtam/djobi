/**
 * Talking to a tab's content script: the two request/response messages the background actually
 * waits on, and the transport rules they both have to obey.
 *
 * These live behind an interface because they're the half of the Application Pipeline's outside
 * world that has real behaviour to hide — the `chrome.runtime.lastError` handshake and the
 * `ArrayBuffer` encoding below are both easy to get wrong and invisible when you do. They used to
 * sit inline in a default-parameter object in `background/applicationPipeline.ts`, which meant the
 * only way to exercise them was to run the whole pipeline.
 *
 * Deliberately separate from the notification-only protocol in `lib/messages.ts`: these two are the
 * only messages in the extension where a response exists at all.
 */
import type { DetectedField, ZodTypeAny, ZodTypeOf } from '@djobi/shared';
import {
  FillFormResultSchema,
  JobPageDataSchema,
  type FillFormResult,
  type JobPageData,
} from './messages';
import { autofillSource } from './fieldDisposition';
import type { FillFormCommandMessage, ScanPageCommandMessage } from './messages';

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
}

/** A content-script reply arrived but did not match the command's response contract. */
export class PageResponseError extends Error {
  constructor(
    readonly command: FillFormCommandMessage['type'] | ScanPageCommandMessage['type'],
    detail?: string,
  ) {
    super(`${command} returned an invalid response${detail ? `: ${detail}` : ''}`);
    this.name = 'PageResponseError';
  }
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
  return new Promise((resolve, reject) => {
    const handle = (response?: unknown): void => {
      void chrome.runtime.lastError;
      if (response == null) {
        resolve(null);
        return;
      }
      const parsed = schema.safeParse(response);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || 'response'} - ${issue.message}`)
          .join('; ');
        reject(new PageResponseError(message.type, detail));
        return;
      }
      resolve(parsed.data as ZodTypeOf<Schema>);
    };

    if (frameId === undefined) chrome.tabs.sendMessage(tabId, message, handle);
    else chrome.tabs.sendMessage(tabId, message, { frameId }, handle);
  });
}

/** The production adapter: the tab's own content script. */
export const chromePageClient: PageClient = {
  async fill(tabId, command, frameId) {
    const message: FillFormCommandMessage = {
      type: 'FILL_FORM',
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
};
