import { EMPTY_PROFILE, type Profile } from '@djobi/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeProfileDraft,
  optionalText,
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
          bullets: ['Led', ' '],
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

    expect(normalized.workExperience[0].bullets).toEqual(['Led']);
    expect(normalized.stories.map(({ id }) => id)).toEqual(['keep', 'new-1', 'new-2', 'new-3']);
    expect(createStoryId).toHaveBeenCalledTimes(4);
    expect(profile.workExperience[0].bullets).toEqual(['Led', ' ']);
    expect(profile.stories.map(({ id }) => id)).toEqual(['keep', '', 'duplicate', 'duplicate']);
  });
});
