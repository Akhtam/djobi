/**
 * The Profile editor's sections, in the order both editors present them.
 *
 * One inventory rather than a `PANEL_ORDER` per app: the two had the same thirteen entries in the
 * same order, differing only in how each *renders* a quick-nav from them, so adding a section meant
 * remembering to add it twice — and a section added to one and not the other would look like a
 * deliberate difference rather than an omission.
 *
 * What is here is what both apps agree on: identity, order, and which half of the editor a section
 * belongs to. Legends, hints and the fields themselves are not — those are the form's, and the form
 * is still each app's until the sections move behind `ProfileChrome`.
 */

/** Which half of the editor a section belongs to — see {@link ProfileSection.group}. */
export type ProfileSectionGroup = 'intake' | 'profile' | 'prep';

/** One section of the Profile editor. */
export interface ProfileSection {
  /**
   * The section's DOM id, and the anchor {@link scrollToSection} scrolls to. Prefixed `section-`
   * because it is a document id shared with the stylesheet, not a key.
   */
  anchor: string;
  /** What the quick-nav calls it — shorter than the section's own heading. */
  label: string;
  /**
   * `intake` is the resume upload: a way to *fill* the form rather than a part of it, which is why
   * the dashboard renders it outside the `<form>` and lists it in no tab. `profile` and `prep` are
   * the dashboard's two tabs; the options page renders every group in one scroll and ignores this.
   */
  group: ProfileSectionGroup;
}

/** Every section, in presentation order. */
export const PROFILE_SECTIONS = [
  { anchor: 'section-upload', label: 'Upload', group: 'intake' },
  { anchor: 'section-contact', label: 'Contact', group: 'profile' },
  { anchor: 'section-links', label: 'Links', group: 'profile' },
  { anchor: 'section-summary', label: 'Summary', group: 'profile' },
  { anchor: 'section-resume', label: 'Resume', group: 'profile' },
  { anchor: 'section-skills', label: 'Skills', group: 'profile' },
  { anchor: 'section-work', label: 'Work', group: 'profile' },
  { anchor: 'section-projects', label: 'Projects', group: 'profile' },
  { anchor: 'section-education', label: 'Education', group: 'profile' },
  { anchor: 'section-credentials', label: 'Credentials', group: 'profile' },
  { anchor: 'section-screening', label: 'Screening', group: 'prep' },
  { anchor: 'section-answers', label: 'Answers', group: 'prep' },
  { anchor: 'section-stories', label: 'Stories', group: 'prep' },
] as const satisfies readonly ProfileSection[];

/** The sections in one group, for a quick-nav that shows a tab's worth at a time. */
export function sectionsInGroup(group: ProfileSectionGroup): readonly ProfileSection[] {
  return PROFILE_SECTIONS.filter((section) => section.group === group);
}

/**
 * Scrolls to a section without touching `location.hash`.
 *
 * A plain `<a href="#section-x">` would fire `hashchange`, which the dashboard's `useHashRoute`
 * reads as an unrecognised route and answers by bouncing the candidate off the profile page
 * entirely. The options page has no router to confuse, but a quick-nav click should not add a
 * history entry there either.
 */
export function scrollToSection(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
