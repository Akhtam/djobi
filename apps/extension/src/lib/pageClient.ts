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
import type { DetectedField } from '@djobi/shared';
import type {
  FillFormCommandMessage,
  FillFormResult,
  JobPageData,
  ScanPageCommandMessage,
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
   */
  fill(tabId: number, command: FillPageCommand): Promise<FillFormResult | null>;
  /** Re-scans the tab's live form, or resolves `null` when no frame answers (no content script, no form). */
  scan(tabId: number): Promise<JobPageData | null>;
}

/**
 * Sends one command to a tab and resolves with its reply, or `null` if no frame answered.
 *
 * Reading `chrome.runtime.lastError` is what marks it handled. An unanswered message — no content
 * script in the tab, or no frame holding a form — would otherwise log as an unchecked runtime
 * error, so this is not optional even though nothing reads the value.
 */
function ask<TResponse>(
  tabId: number,
  message: FillFormCommandMessage | ScanPageCommandMessage,
): Promise<TResponse | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response?: TResponse) => {
      void chrome.runtime.lastError;
      resolve(response ?? null);
    });
  });
}

/** The production adapter: the tab's own content script. */
export const chromePageClient: PageClient = {
  fill(tabId, command) {
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
    return ask<FillFormResult>(tabId, message);
  },

  scan(tabId) {
    const message: ScanPageCommandMessage = { type: 'SCAN_PAGE' };
    return ask<JobPageData>(tabId, message);
  },
};
