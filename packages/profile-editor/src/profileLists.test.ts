import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { profileListEditors } from './profileLists.js';

/** Runs one edit against `profile` and returns what the editors wrote. */
function edit(profile: Profile, act: (lists: ReturnType<typeof profileListEditors>) => void) {
  const setProfile = vi.fn<(next: Profile) => void>();
  act(profileListEditors(profile, setProfile, () => 'story-id'));
  expect(setProfile).toHaveBeenCalledTimes(1);
  return setProfile.mock.calls[0][0];
}

describe('profileListEditors', () => {
  it('adds a blank entry to the list its section owns', () => {
    expect(edit(EMPTY_PROFILE, (lists) => lists.work.add()).workExperience).toEqual([
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
    ]);
    expect(edit(EMPTY_PROFILE, (lists) => lists.education.add()).education).toEqual([
      { school: '', degree: '', field: null, graduationYear: null },
    ]);
    expect(edit(EMPTY_PROFILE, (lists) => lists.projects.add()).projects).toEqual([
      { name: '', description: '', bullets: [], link: null, technologies: null },
    ]);
    expect(edit(EMPTY_PROFILE, (lists) => lists.customAnswers.add()).customAnswers).toEqual([
      { question: '', answer: '' },
    ]);
  });

  it('gives a new story an id without waiting for the candidate to type one', () => {
    // Answer provenance stores Story ids, so a row that never had its id field touched still has
    // to be addressable.
    const [story] = edit(EMPTY_PROFILE, (lists) => lists.stories.add()).stories;
    expect(story.id).toBe('story-id');
  });

  describe('the combined Certifications & Awards section', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      certifications: [{ name: 'CKA', issuer: 'CNCF', date: '2024' }],
      awards: [{ name: 'Prize', issuer: 'Acme', date: '2023', description: 'For work' }],
    };

    it('lists certifications first, each tagged with where it lives', () => {
      const { credentials } = profileListEditors(profile, vi.fn(), () => 'story-id');
      expect(credentials.items).toEqual([
        { kind: 'certification', index: 0, name: 'CKA', issuer: 'CNCF', date: '2024' },
        {
          kind: 'award',
          index: 0,
          name: 'Prize',
          issuer: 'Acme',
          date: '2023',
          description: 'For work',
        },
      ]);
    });

    it('dispatches a row write to whichever real list owns it', () => {
      // Row 1 is the award, which lives at index 0 of a different array than its combined index.
      const written = edit(profile, (lists) =>
        lists.credentials.editor.update(1, { name: 'Renamed' }),
      );
      expect(written.awards[0].name).toBe('Renamed');
      expect(written.certifications[0].name).toBe('CKA');

      const removed = edit(profile, (lists) => lists.credentials.editor.remove(1));
      expect(removed.awards).toEqual([]);
      expect(removed.certifications).toHaveLength(1);
    });

    it('adds new rows as certifications, for the row picker to change', () => {
      const written = edit(profile, (lists) => lists.credentials.editor.add());
      expect(written.certifications).toHaveLength(2);
      expect(written.awards).toHaveLength(1);
    });

    it('moves a row between the two lists, carrying the shared fields', () => {
      const written = edit(profile, (lists) =>
        lists.credentials.changeKind(lists.credentials.items[0], 'award'),
      );
      expect(written.certifications).toEqual([]);
      expect(written.awards).toEqual([
        { name: 'Prize', issuer: 'Acme', date: '2023', description: 'For work' },
        { name: 'CKA', issuer: 'CNCF', date: '2024' },
      ]);
    });
  });
});
