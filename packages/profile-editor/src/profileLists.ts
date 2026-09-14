/**
 * Every list section's editor, bound to one draft in one call.
 *
 * `listEditor` already owned the three operations; what both editors still repeated was the
 * *inventory* — seven `listEditor(profile, setProfile, key, blank)` calls with their blank-entry
 * literals, the combined Certifications & Awards dispatcher, and the credential-kind change — 48
 * lines that were byte-identical between `apps/extension/src/options/App.tsx` and
 * `apps/dashboard/src/views/Profile.tsx`. A field added to a blank entry had to be added twice, and
 * a row added to one editor's Profile shape but not the other's would not have failed anything.
 *
 * Nothing here renders. The chrome around a list section — the card, the entry shell, the add
 * affordance — stays with each app, which is why this is a plain function rather than a component.
 */
import type { Award, Certification, Profile } from '@djobi/shared';
import {
  credentialItems,
  listEditor,
  type CredentialItem,
  type ListEditor,
} from './listEditing.js';
import { changeCredentialKind } from './profileDraft.js';

/** One entry of the Profile's `customAnswers` — `@djobi/shared` names the other six entry types. */
export type CustomAnswer = Profile['customAnswers'][number];

/**
 * The combined Certifications & Awards section: the rows, the editor that dispatches each row's
 * writes to whichever real list owns it, and the kind picker on the row itself.
 */
export interface CredentialsEditor {
  /** Certifications then awards, each tagged with where it lives. */
  items: CredentialItem[];
  editor: ListEditor<CredentialItem>;
  /** Moves one row between `certifications` and `awards`, carrying the three shared fields. */
  changeKind(item: CredentialItem, kind: CredentialItem['kind']): void;
}

/** Every editable list on a Profile, keyed the way the sections are named on screen. */
export interface ProfileListEditors {
  work: ListEditor<Profile['workExperience'][number]>;
  education: ListEditor<Profile['education'][number]>;
  stories: ListEditor<Profile['stories'][number]>;
  customAnswers: ListEditor<CustomAnswer>;
  projects: ListEditor<Profile['projects'][number]>;
  certifications: ListEditor<Certification>;
  awards: ListEditor<Award>;
  credentials: CredentialsEditor;
}

/**
 * Binds every list section's editor to one draft.
 *
 * `createStoryId` is a parameter for the same reason `normalizeProfileDraft` takes one: answer
 * provenance stores Story ids, so a new entry needs a stable unique value even when the candidate
 * never touches the editable id field — and a test that wants to assert on the result needs that
 * value to be predictable. Production callers take the default.
 */
export function profileListEditors(
  profile: Profile,
  setProfile: (profile: Profile) => void,
  createStoryId: () => string = () => crypto.randomUUID(),
): ProfileListEditors {
  const work = listEditor(profile, setProfile, 'workExperience', () => ({
    company: '',
    title: '',
    startDate: '',
    endDate: null,
    bullets: [],
    maxBullets: null,
    starredIndices: [],
    suppressIfEmpty: false,
  }));
  const education = listEditor(profile, setProfile, 'education', () => ({
    school: '',
    degree: '',
    field: null,
    graduationYear: null,
  }));
  const stories = listEditor(profile, setProfile, 'stories', () => ({
    id: createStoryId(),
    title: '',
    tags: [],
    situation: '',
    task: '',
    action: '',
    result: '',
  }));
  const customAnswers = listEditor(profile, setProfile, 'customAnswers', () => ({
    question: '',
    answer: '',
  }));
  const projects = listEditor(profile, setProfile, 'projects', () => ({
    name: '',
    description: '',
    bullets: [],
    link: null,
    technologies: null,
  }));
  const certifications = listEditor(profile, setProfile, 'certifications', () => ({
    name: '',
    issuer: '',
    date: '',
  }));
  const awards = listEditor(profile, setProfile, 'awards', () => ({
    name: '',
    issuer: '',
    date: '',
  }));

  const items = credentialItems(profile);
  /**
   * `.remove`/`.add` are what a list section itself calls; `.update` is called directly from the
   * row's own fields, the same way `certifications.update` would be if this were still its own
   * section. Each dispatches to whichever of the two real editors owns the row at `combinedIndex`.
   */
  const credentialsEditor: ListEditor<CredentialItem> = {
    update: (combinedIndex, patch) => {
      const item = items[combinedIndex];
      if (!item) return;
      if (item.kind === 'certification')
        certifications.update(item.index, patch as Partial<Certification>);
      else awards.update(item.index, patch as Partial<Award>);
    },
    remove: (combinedIndex) => {
      const item = items[combinedIndex];
      if (!item) return;
      if (item.kind === 'certification') certifications.remove(item.index);
      else awards.remove(item.index);
    },
    // New rows default to a certification; the picker on the row itself is how the candidate
    // switches it, immediately if it should have been an award instead.
    add: () => certifications.add(),
  };

  return {
    work,
    education,
    stories,
    customAnswers,
    projects,
    certifications,
    awards,
    credentials: {
      items,
      editor: credentialsEditor,
      changeKind: (item, kind) =>
        setProfile(
          changeCredentialKind(profile, item.index, item.kind, kind, {
            name: item.name,
            issuer: item.issuer,
            date: item.date,
          }),
        ),
    },
  };
}
