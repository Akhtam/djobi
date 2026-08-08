/**
 * Heuristic: is this ATS-host page (already host-matched by `manifest.ts`) an actual application
 * form, not a marketing/listing/login page on the same domain? A resume file upload input is the
 * strongest signal a form on the page is an application form.
 */
export function isJobApplicationPage(doc: Document): boolean {
  return doc.querySelector('form input[type="file"]') !== null;
}
