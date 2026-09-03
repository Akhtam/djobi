import { describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { credentialItems, listEditor } from './listEditing.js';

describe('listEditor', () => {
  const blankEducation = () => ({ school: '', degree: '', field: '', startDate: '', endDate: '' });

  it('adds, updates and removes entries against the profile it was built from', () => {
    let profile: Profile = EMPTY_PROFILE;
    const setProfile = (next: Profile) => {
      profile = next;
    };
    const education = () => listEditor(profile, setProfile, 'education', blankEducation);

    education().add();
    expect(profile.education).toHaveLength(1);

    education().update(0, { school: 'Rice University' });
    expect(profile.education[0]).toMatchObject({ school: 'Rice University' });

    education().add();
    education().remove(0);
    expect(profile.education).toHaveLength(1);
    // The remaining entry is the second one added, not a patched copy of the first.
    expect(profile.education[0].school).toBe('');
  });
});

describe('credentialItems', () => {
  it('lists certifications before awards, each tagged with its own array index', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      certifications: [{ name: 'AWS SAA', issuer: 'AWS', date: '2024' }],
      awards: [
        { name: 'Employee of the month', issuer: 'Acme', date: '2023' },
        { name: 'Hackathon winner', issuer: 'Acme', date: '2022' },
      ],
    };

    expect(credentialItems(profile)).toEqual([
      { kind: 'certification', index: 0, name: 'AWS SAA', issuer: 'AWS', date: '2024' },
      { kind: 'award', index: 0, name: 'Employee of the month', issuer: 'Acme', date: '2023' },
      { kind: 'award', index: 1, name: 'Hackathon winner', issuer: 'Acme', date: '2022' },
    ]);
  });
});
