/**
 * File name for a generated (tailored) resume PDF, derived from the profile's `fullName` so the
 * file an employer receives is identifiable rather than a generic `resume.pdf`: "Joe Doe" becomes
 * `joe_doe_resume.pdf`.
 */
export function resumeFileName(fullName: string): string {
  const slug = fullName
    .toLowerCase()
    .normalize('NFKD')
    // Drop accents so "José" becomes "jose" rather than "jos_".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // A profile with no usable name (blank, or entirely non-latin) still has to produce a valid file
  // name, so fall back to the plain one.
  return slug ? `${slug}_resume.pdf` : 'resume.pdf';
}
