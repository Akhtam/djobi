/**
 * Content script injected on ATS host pages (`manifest.ts` → `content_scripts`). On load, reports
 * a detected job application page to the background service worker; always listens for a
 * `FILL_FORM` command back from the popup (via background) to fill the page.
 */
import type { FillFormCommandMessage } from '../lib/messages';
import { detectFields } from './detectFields';
import { isJobApplicationPage } from './detect';
import { attachResumeFile, fillForm, resolveField } from './fillForm';
import { scrapePageText } from './scrapeJob';

if (isJobApplicationPage(document)) {
  chrome.runtime.sendMessage({
    type: 'REPORT_JOB_PAGE',
    pageText: scrapePageText(document),
    fields: detectFields(document),
  });
}

chrome.runtime.onMessage.addListener(
  (message: FillFormCommandMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (message.type !== 'FILL_FORM') return;

    fillForm(document, message.fields, message.values);

    if (message.resumeFile) {
      const uploadField = message.fields.find((field) => field.category === 'resume_upload');
      const input = uploadField ? resolveField<HTMLInputElement>(document, uploadField) : null;

      if (input) {
        const file = new File([new Uint8Array(message.resumeFile.bytes)], message.resumeFile.name, {
          type: message.resumeFile.type,
        });
        attachResumeFile(input, file);
      }
    }

    sendResponse({ ok: true });
  },
);
