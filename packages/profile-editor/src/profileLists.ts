/**
 * Every list section's editor bound to one draft in one call, including the combined
 * Certifications & Awards dispatcher and blank-entry literals. Renders nothing; chrome stays with
 * each app.
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
 * The combined Certifications & Awards section: rows, a dispatching editor, and the kind picker.
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
 * Binds every list section's editor to one draft. `createStoryId` is injectable so tests get
 * predictable ids.
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
  /** Each operation dispatches to whichever real list owns the row at `combinedIndex`. */
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
