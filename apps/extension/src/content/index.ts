/**
 * Content script injected on every page (`manifest.ts` → `content_scripts`). Watches for the page
 * to become a job application form — immediately if it already is one, or within a bounded window
 * if an ATS embed widget renders it in asynchronously (see `detect.ts`) — and reports it to the
 * background service worker; always listens for a `FILL_FORM` command back from the side panel
 * (via background) to fill the page.
 */
import type { FillFormCommandMessage } from '../lib/messages';
import { detectFields } from './detectFields';
import { watchForJobApplicationPage } from './detect';
import { attachResumeFile, fillForm, resolveField } from './fillForm';
import { scrapePageText } from './scrapeJob';

watchForJobApplicationPage(document, () => {
  chrome.runtime.sendMessage({
    type: 'REPORT_JOB_PAGE',
    pageText: scrapePageText(document),
    fields: detectFields(document),
  });
});

chrome.runtime.onMessage.addListener(
  (message: FillFormCommandMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (message.type !== 'FILL_FORM') return;

    void (async () => {
      await fillForm(document, message.fields, message.values);

      if (message.resumeFile) {
        // Some ATS platforms (e.g. Ashby) render more than one resume_upload-classified file
        // input — prefer the required one so the file lands on the field that's actually
        // validated, not an unlabeled/decoy one that happens to come first.
        const uploadField =
          message.fields.find((field) => field.category === 'resume_upload' && field.required) ??
          message.fields.find((field) => field.category === 'resume_upload');
        const input = uploadField ? resolveField<HTMLInputElement>(document, uploadField) : null;

        if (input) {
          const file = new File(
            [new Uint8Array(message.resumeFile.bytes)],
            message.resumeFile.name,
            { type: message.resumeFile.type },
          );
          attachResumeFile(input, file);
        }
      }

      sendResponse({ ok: true });
    })();

    return true; // keep the message channel open for the async sendResponse above
  },
);
