import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeProfileDraft,
  optionalText,
  spliceWorkBullets,
  storyTags,
  withScreeningAnswer,
} from './profileDraft';

const story = {
  title: '',
  tags: [],
  situation: '',
  task: '',
  action: '',
  result: '',
};

describe('profile draft normalization', () => {
  it('represents cleared optional inputs and screening answers as absent', () => {
    expect(optionalText('  ')).toBeNull();
    expect(optionalText('  London  ')).toBe('  London  ');
    expect(
      withScreeningAnswer(
        { work_authorization: 'Yes', sponsorship_required: 'No' },
        'sponsorship_required',
        ' ',
      ),
    ).toEqual({ work_authorization: 'Yes' });
    expect(withScreeningAnswer({}, 'sponsorship_required', '  Yes  ')).toEqual({
      sponsorship_required: '  Yes  ',
    });
  });

  it('parses comma-separated story tags and drops blank entries', () => {
    expect(storyTags(' leadership, , incident-response,')).toEqual([
      'leadership',
      'incident-response',
    ]);
  });

  it('drops blank bullets and repairs blank or duplicate story ids', () => {
    const profile: Profile = {
      ...EMPTY_PROFILE,
      workExperience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2024',
          endDate: null,
          bullets: ['Led', ' ', 'Built'],
          maxBullets: null,
          starredIndices: [0, 2],
        },
      ],
      stories: [
        { ...story, id: 'keep' },
        { ...story, id: '' },
        { ...story, id: 'duplicate' },
        { ...story, id: 'duplicate' },
      ],
    };
    const generatedIds = ['keep', 'new-1', 'new-2', 'new-3'];
    const createStoryId = vi.fn(() => generatedIds.shift()!);

    const normalized = normalizeProfileDraft(profile, createStoryId);

    expect(normalized.workExperience[0].bullets).toEqual(['Led', 'Built']);
    expect(normalized.workExperience[0].starredIndices).toEqual([0, 1]);
    expect(normalized.stories.map(({ id }) => id)).toEqual(['keep', 'new-1', 'new-2', 'new-3']);
    expect(createStoryId).toHaveBeenCalledTimes(4);
    expect(profile.workExperience[0].bullets).toEqual(['Led', ' ', 'Built']);
    expect(profile.workExperience[0].starredIndices).toEqual([0, 2]);
    expect(profile.stories.map(({ id }) => id)).toEqual(['keep', '', 'duplicate', 'duplicate']);
  });

  it('remaps starred indices when bullets are inserted or deleted', () => {
    const entry: Profile['workExperience'][number] = {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2024',
      endDate: null,
      bullets: ['First', 'Second', 'Third'],
      maxBullets: null,
      starredIndices: [0, 2],
    };

    const inserted = spliceWorkBullets(entry, 1, 0, 'Inserted');
    expect(inserted.bullets).toEqual(['First', 'Inserted', 'Second', 'Third']);
    expect(inserted.starredIndices).toEqual([0, 3]);

    const removed = spliceWorkBullets(inserted, 0, 2);
    expect(removed.bullets).toEqual(['Second', 'Third']);
    expect(removed.starredIndices).toEqual([1]);
  });
});
