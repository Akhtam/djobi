import { render, screen } from '@testing-library/react';
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import type { FieldChrome } from './fieldChrome.js';
import { profileListEditors } from './profileLists.js';
import {
  ProfileSectionEntry,
  ProfileSectionFields,
  type ProfileFieldsSectionKey,
  type ProfileListSectionKey,
} from './profileSectionBodies.js';

const chrome: FieldChrome = {
  Field: ({ id, label, children }) => (
    <label data-testid={`test-field-${id}`}>
      {label}
      {children}
    </label>
  ),
  Checkbox: ({ id, label, checked, onChange }) => (
    <label data-testid={`test-field-${id}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  ),
};

describe('profile section bodies', () => {
  it('renders every fixed body through caller-provided field chrome', () => {
    const sections: ProfileFieldsSectionKey[] = [
      'contact',
      'links',
      'summary',
      'resume',
      'screening',
    ];
    render(
      <>
        {sections.map((section) => (
          <ProfileSectionFields
            key={section}
            section={section}
            chrome={chrome}
            profile={EMPTY_PROFILE}
            onChange={vi.fn()}
          />
        ))}
      </>,
    );

    expect(screen.getByTestId('test-field-fullName')).toBeTruthy();
    expect(screen.getByTestId('test-field-linkedin')).toBeTruthy();
    expect(screen.getByTestId('test-field-summary')).toBeTruthy();
    expect(screen.getByTestId('test-field-resumePageSize')).toBeTruthy();
    expect(screen.getByTestId('test-field-work_authorization')).toBeTruthy();
  });

  it('renders every list-entry body through caller-provided field chrome', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      workExperience: [
        {
          company: '',
          title: '',
          startDate: '',
          endDate: null,
          bullets: [],
          maxBullets: null,
          starredIndices: [],
          suppressIfEmpty: false,
        },
      ],
      projects: [{ name: '', description: '', bullets: [], link: null, technologies: null }],
      education: [{ school: '', degree: '', field: null, graduationYear: null }],
      certifications: [{ name: '', issuer: '', date: '' }],
      customAnswers: [{ question: '', answer: '' }],
      stories: [
        { id: 'story-1', title: '', tags: [], situation: '', task: '', action: '', result: '' },
      ],
    };
    const editors = profileListEditors(profile, vi.fn());
    const entries = {
      work: profile.workExperience[0],
      projects: profile.projects[0],
      education: profile.education[0],
      credentials: editors.credentials.items[0],
      answers: profile.customAnswers[0],
      stories: profile.stories[0],
    } satisfies Record<ProfileListSectionKey, unknown>;

    render(
      <>
        {(Object.keys(entries) as ProfileListSectionKey[]).map((section) => (
          <ProfileSectionEntry
            key={section}
            section={section}
            chrome={chrome}
            entry={entries[section] as never}
            index={0}
            editors={editors}
            maxBulletsPerRole={3}
          />
        ))}
      </>,
    );

    for (const id of [
      'weCompany1',
      'projName1',
      'eduSchool1',
      'credKind1',
      'customQuestion-0',
      'storyId1',
    ]) {
      expect(screen.getByTestId(`test-field-${id}`)).toBeTruthy();
    }
  });
});
