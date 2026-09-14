/**
 * The Profile editor's sections, in the order both editors present them.
 *
 * One inventory rather than a `PANEL_ORDER` per app: the two had the same thirteen entries in the
 * same order, differing only in how each *renders* a quick-nav from them, so adding a section meant
 * remembering to add it twice — and a section added to one and not the other would look like a
 * deliberate difference rather than an omission.
 *
 * What is here is what both apps agree on: identity, order, copy, body kind, and which half of the
 * editor a section belongs to. The shells, controls, summaries, and app-owned upload/skills bodies
 * stay in each app.
 */

/** Which half of the editor a section belongs to — see {@link ProfileSection.group}. */
export type ProfileSectionGroup = 'intake' | 'profile' | 'prep';

export type ProfileSectionKey =
  | 'upload'
  | 'contact'
  | 'links'
  | 'summary'
  | 'resume'
  | 'skills'
  | 'work'
  | 'projects'
  | 'education'
  | 'credentials'
  | 'screening'
  | 'answers'
  | 'stories';

export type ProfileSectionBodyKind = 'app' | 'fields' | 'list';

/** One section of the Profile editor. */
export interface ProfileSection {
  key: ProfileSectionKey;
  /**
   * The section's DOM id, and the anchor {@link scrollToSection} scrolls to. Prefixed `section-`
   * because it is a document id shared with the stylesheet, not a key.
   */
  anchor: string;
  /** What the quick-nav calls it — shorter than the section's own heading. */
  label: string;
  title: string;
  hint?: string;
  body: ProfileSectionBodyKind;
  noun?: string;
  addLabel?: string;
  /**
   * `intake` is the resume upload: a way to *fill* the form rather than a part of it, which is why
   * the dashboard renders it outside the `<form>` and lists it in no tab. `profile` and `prep` are
   * the dashboard's two tabs; the options page renders every group in one scroll and ignores this.
   */
  group: ProfileSectionGroup;
}

/** Every section, in presentation order. */
export const PROFILE_SECTIONS: readonly [
  {
    readonly key: 'upload';
    readonly anchor: 'section-upload';
    readonly label: 'Upload';
    readonly title: 'Upload resume';
    readonly group: 'intake';
    readonly body: 'app';
  },
  {
    readonly key: 'contact';
    readonly anchor: 'section-contact';
    readonly label: 'Contact';
    readonly title: 'Contact details';
    readonly group: 'profile';
    readonly body: 'fields';
  },
  {
    readonly key: 'links';
    readonly anchor: 'section-links';
    readonly label: 'Links';
    readonly title: 'Links';
    readonly group: 'profile';
    readonly body: 'fields';
  },
  {
    readonly key: 'summary';
    readonly anchor: 'section-summary';
    readonly label: 'Summary';
    readonly title: 'Summary';
    readonly hint: 'A short intro paragraph, shown near the top of the resume.';
    readonly group: 'profile';
    readonly body: 'fields';
  },
  {
    readonly key: 'resume';
    readonly anchor: 'section-resume';
    readonly label: 'Resume';
    readonly title: 'Resume PDF';
    readonly hint: 'Formatting used for both resume previews and attachments.';
    readonly group: 'profile';
    readonly body: 'fields';
  },
  {
    readonly key: 'skills';
    readonly anchor: 'section-skills';
    readonly label: 'Skills';
    readonly title: 'Skills';
    readonly group: 'profile';
    readonly body: 'app';
  },
  {
    readonly key: 'work';
    readonly anchor: 'section-work';
    readonly label: 'Work';
    readonly title: 'Work experience';
    readonly hint: 'Keep the full bullet bank for each role. Star must-keep evidence; tailoring selects the rest up to the cap.';
    readonly noun: 'work experience';
    readonly addLabel: 'Add work experience';
    readonly group: 'profile';
    readonly body: 'list';
  },
  {
    readonly key: 'projects';
    readonly anchor: 'section-projects';
    readonly label: 'Projects';
    readonly title: 'Projects';
    readonly hint: 'Personal, open-source or freelance work — anything not covered by Work experience above.';
    readonly noun: 'project';
    readonly addLabel: 'Add project';
    readonly group: 'profile';
    readonly body: 'list';
  },
  {
    readonly key: 'education';
    readonly anchor: 'section-education';
    readonly label: 'Education';
    readonly title: 'Education';
    readonly noun: 'education';
    readonly addLabel: 'Add education';
    readonly group: 'profile';
    readonly body: 'list';
  },
  {
    readonly key: 'credentials';
    readonly anchor: 'section-credentials';
    readonly label: 'Credentials';
    readonly title: 'Certifications & Awards';
    readonly hint: 'Pick which each row is — the fields shown adjust to match.';
    readonly noun: 'certification or award';
    readonly addLabel: 'Add certification or award';
    readonly group: 'profile';
    readonly body: 'list';
  },
  {
    readonly key: 'screening';
    readonly anchor: 'section-screening';
    readonly label: 'Screening';
    readonly title: 'Screening answers';
    readonly hint: 'The questions almost every application asks. Anything answered here is filled in directly — the AI is never asked to guess it. Leave a row blank to let it be drafted as usual.';
    readonly group: 'prep';
    readonly body: 'fields';
  },
  {
    readonly key: 'answers';
    readonly anchor: 'section-answers';
    readonly label: 'Answers';
    readonly title: 'Other prepared answers';
    readonly hint: "Anything else you're asked repeatedly. The question is matched loosely against the form's own wording, so it needn't be phrased identically.";
    readonly noun: 'prepared answer';
    readonly addLabel: 'Add prepared answer';
    readonly group: 'prep';
    readonly body: 'list';
  },
  {
    readonly key: 'stories';
    readonly anchor: 'section-stories';
    readonly label: 'Stories';
    readonly title: 'Stories';
    readonly noun: 'story';
    readonly addLabel: 'Add story';
    readonly group: 'prep';
    readonly body: 'list';
  },
] = [
  {
    key: 'upload',
    anchor: 'section-upload',
    label: 'Upload',
    title: 'Upload resume',
    group: 'intake',
    body: 'app',
  },
  {
    key: 'contact',
    anchor: 'section-contact',
    label: 'Contact',
    title: 'Contact details',
    group: 'profile',
    body: 'fields',
  },
  {
    key: 'links',
    anchor: 'section-links',
    label: 'Links',
    title: 'Links',
    group: 'profile',
    body: 'fields',
  },
  {
    key: 'summary',
    anchor: 'section-summary',
    label: 'Summary',
    title: 'Summary',
    hint: 'A short intro paragraph, shown near the top of the resume.',
    group: 'profile',
    body: 'fields',
  },
  {
    key: 'resume',
    anchor: 'section-resume',
    label: 'Resume',
    title: 'Resume PDF',
    hint: 'Formatting used for both resume previews and attachments.',
    group: 'profile',
    body: 'fields',
  },
  {
    key: 'skills',
    anchor: 'section-skills',
    label: 'Skills',
    title: 'Skills',
    group: 'profile',
    body: 'app',
  },
  {
    key: 'work',
    anchor: 'section-work',
    label: 'Work',
    title: 'Work experience',
    hint: 'Keep the full bullet bank for each role. Star must-keep evidence; tailoring selects the rest up to the cap.',
    noun: 'work experience',
    addLabel: 'Add work experience',
    group: 'profile',
    body: 'list',
  },
  {
    key: 'projects',
    anchor: 'section-projects',
    label: 'Projects',
    title: 'Projects',
    hint: 'Personal, open-source or freelance work — anything not covered by Work experience above.',
    noun: 'project',
    addLabel: 'Add project',
    group: 'profile',
    body: 'list',
  },
  {
    key: 'education',
    anchor: 'section-education',
    label: 'Education',
    title: 'Education',
    noun: 'education',
    addLabel: 'Add education',
    group: 'profile',
    body: 'list',
  },
  {
    key: 'credentials',
    anchor: 'section-credentials',
    label: 'Credentials',
    title: 'Certifications & Awards',
    hint: 'Pick which each row is — the fields shown adjust to match.',
    noun: 'certification or award',
    addLabel: 'Add certification or award',
    group: 'profile',
    body: 'list',
  },
  {
    key: 'screening',
    anchor: 'section-screening',
    label: 'Screening',
    title: 'Screening answers',
    hint: 'The questions almost every application asks. Anything answered here is filled in directly — the AI is never asked to guess it. Leave a row blank to let it be drafted as usual.',
    group: 'prep',
    body: 'fields',
  },
  {
    key: 'answers',
    anchor: 'section-answers',
    label: 'Answers',
    title: 'Other prepared answers',
    hint: "Anything else you're asked repeatedly. The question is matched loosely against the form's own wording, so it needn't be phrased identically.",
    noun: 'prepared answer',
    addLabel: 'Add prepared answer',
    group: 'prep',
    body: 'list',
  },
  {
    key: 'stories',
    anchor: 'section-stories',
    label: 'Stories',
    title: 'Stories',
    noun: 'story',
    addLabel: 'Add story',
    group: 'prep',
    body: 'list',
  },
] as const satisfies readonly ProfileSection[];

export const PROFILE_SECTION_BY_KEY = Object.fromEntries(
  PROFILE_SECTIONS.map((section) => [section.key, section]),
) as { [K in ProfileSectionKey]: Extract<(typeof PROFILE_SECTIONS)[number], { key: K }> };

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
