import type { ReactNode } from 'react';
import type { Profile } from '@djobi/shared';
import type { BulletListClassNames, FieldChrome } from './fieldChrome.js';
import type { CredentialItem } from './listEditing.js';
import {
  ContactFields,
  CredentialEntryFields,
  CustomAnswerEntryFields,
  EducationEntryFields,
  LinksFields,
  ProjectEntryFields,
  ResumeSettingsFields,
  ScreeningAnswerFields,
  StoryEntryFields,
  SummaryField,
  WorkExperienceEntryFields,
} from './profileFieldBodies.js';
import type { ProfileListEditors } from './profileLists.js';

export type ProfileFieldsSectionKey = 'contact' | 'links' | 'summary' | 'resume' | 'screening';
export type ProfileListSectionKey =
  'work' | 'projects' | 'education' | 'credentials' | 'answers' | 'stories';

export function ProfileSectionFields({
  section,
  chrome,
  profile,
  onChange,
}: {
  section: ProfileFieldsSectionKey;
  chrome: FieldChrome;
  profile: Profile;
  onChange: (next: Profile) => void;
}) {
  switch (section) {
    case 'contact':
      return <ContactFields chrome={chrome} profile={profile} onChange={onChange} />;
    case 'links':
      return <LinksFields chrome={chrome} profile={profile} onChange={onChange} />;
    case 'summary':
      return <SummaryField chrome={chrome} profile={profile} onChange={onChange} />;
    case 'resume':
      return <ResumeSettingsFields chrome={chrome} profile={profile} onChange={onChange} />;
    case 'screening':
      return <ScreeningAnswerFields chrome={chrome} profile={profile} onChange={onChange} />;
  }
}

type Entry =
  | Profile['workExperience'][number]
  | Profile['projects'][number]
  | Profile['education'][number]
  | CredentialItem
  | Profile['customAnswers'][number]
  | Profile['stories'][number];

export function ProfileSectionEntry({
  section,
  chrome,
  bulletListClassNames,
  entry,
  index,
  editors,
  maxBulletsPerRole,
}: {
  section: ProfileListSectionKey;
  chrome: FieldChrome;
  bulletListClassNames?: BulletListClassNames;
  entry: Entry;
  index: number;
  editors: ProfileListEditors;
  maxBulletsPerRole: number;
}) {
  switch (section) {
    case 'work':
      return (
        <WorkExperienceEntryFields
          chrome={chrome}
          bulletListClassNames={bulletListClassNames ?? {}}
          entry={entry as Profile['workExperience'][number]}
          index={index}
          maxBulletsPerRole={maxBulletsPerRole}
          work={editors.work}
        />
      );
    case 'projects':
      return (
        <ProjectEntryFields
          chrome={chrome}
          bulletListClassNames={bulletListClassNames ?? {}}
          entry={entry as Profile['projects'][number]}
          index={index}
          projects={editors.projects}
        />
      );
    case 'education':
      return (
        <EducationEntryFields
          chrome={chrome}
          entry={entry as Profile['education'][number]}
          index={index}
          education={editors.education}
        />
      );
    case 'credentials':
      return (
        <CredentialEntryFields
          chrome={chrome}
          item={entry as CredentialItem}
          index={index}
          editor={editors.credentials.editor}
          changeKind={editors.credentials.changeKind}
        />
      );
    case 'answers':
      return (
        <CustomAnswerEntryFields
          chrome={chrome}
          entry={entry as Profile['customAnswers'][number]}
          index={index}
          customAnswers={editors.customAnswers}
        />
      );
    case 'stories':
      return (
        <StoryEntryFields
          chrome={chrome}
          entry={entry as Profile['stories'][number]}
          index={index}
          stories={editors.stories}
        />
      );
  }
}

/**
 * The child render-prop every `<ListSection>` for a list-kind section needs — the closure both
 * apps wrote out six times each, identically but for the wrapper's class name and, on `work` and
 * `projects`, `bulletListClassNames`.
 *
 * `maxBulletsPerRole` lives on `ctx` rather than threaded through every call site the way it used
 * to be: only `work` and `projects` cap bullets, so `ProfileSectionEntry`'s other four branches
 * never read the parameter, and a host no longer has to hand a bullet cap to an Education or Story
 * row to satisfy a signature it has no use for.
 */
export function profileListSectionEntry<K extends ProfileListSectionKey>(
  section: K,
  ctx: {
    chrome: FieldChrome;
    editors: ProfileListEditors;
    /**
     * Applied to the wrapping `<div>` around the entry's fields — the one thing left to the host.
     * Omit it (as the options page's Answers section does today) to render with no wrapper at all,
     * rather than an empty `<div>` a bare omission would otherwise leave behind.
     */
    wrapperClassName?: string;
    bulletListClassNames?: BulletListClassNames;
    maxBulletsPerRole: number;
  },
): (entry: Entry, index: number) => ReactNode {
  return (entry, index) => {
    const fields = (
      <ProfileSectionEntry
        section={section}
        chrome={ctx.chrome}
        bulletListClassNames={ctx.bulletListClassNames}
        entry={entry}
        index={index}
        editors={ctx.editors}
        maxBulletsPerRole={ctx.maxBulletsPerRole}
      />
    );
    return ctx.wrapperClassName ? <div className={ctx.wrapperClassName}>{fields}</div> : fields;
  };
}
