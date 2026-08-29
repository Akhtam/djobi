import { FieldCategorySchema, type FieldCategory, type Profile } from '@djobi/shared';
import { describe, expect, it } from 'vitest';
import { AUTOFILL_SOURCE, autofillSource, valueForCategory } from './fieldDisposition';

const profile: Profile = {
  fullName: 'Ada Lovelace King',
  email: 'ada@example.com',
  phone: '+44 20 7946 0000',
  location: 'London, UK',
  links: {
    linkedin: 'https://linkedin.com/in/ada',
    portfolio: 'https://ada.example.com',
    github: 'https://github.com/ada',
  },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  customAnswers: [],
  screeningAnswers: {},
};

describe('AUTOFILL_SOURCE', () => {
  it('gives every category a disposition, so a new one cannot be added silently', () => {
    // The property the old `default: undefined` destroyed: a 15th category used to compile, detect,
    // cross every boundary and be skipped, indistinguishable from one deliberately left alone.
    for (const category of FieldCategorySchema.options) {
      expect(AUTOFILL_SOURCE[category]).toBeDefined();
    }
  });

  it('records the cover-letter scope decision as a decision, not as an absence', () => {
    // `PROGRESS.md` calls this out under "Constraints that look like mistakes": cover-letter fields
    // are detected but deliberately not filled, because `answerQuestions` is wired only to
    // `question` fields. Stated here, it is enforced rather than merely written down.
    expect(autofillSource('cover_letter_text')).toBe('unsupported');
    expect(autofillSource('cover_letter_upload')).toBe('unsupported');
    expect(autofillSource('unknown')).toBe('unsupported');
  });

  it('names the resume upload as the one file the Fill Step attaches', () => {
    expect(autofillSource('resume_upload')).toBe('resume');
    expect(autofillSource('question')).toBe('question');
  });
});

describe('valueForCategory', () => {
  it('projects each profile-backed category onto the value that fills it', () => {
    expect(valueForCategory('first_name', profile)).toBe('Ada');
    expect(valueForCategory('last_name', profile)).toBe('Lovelace King');
    expect(valueForCategory('full_name', profile)).toBe('Ada Lovelace King');
    expect(valueForCategory('email', profile)).toBe('ada@example.com');
    expect(valueForCategory('phone', profile)).toBe('+44 20 7946 0000');
    expect(valueForCategory('location', profile)).toBe('London, UK');
    expect(valueForCategory('linkedin_url', profile)).toBe('https://linkedin.com/in/ada');
    expect(valueForCategory('portfolio_url', profile)).toBe('https://ada.example.com');
    expect(valueForCategory('github_url', profile)).toBe('https://github.com/ada');
  });

  it('leaves a one-word name with no surname rather than repeating the first', () => {
    const mononym = { ...profile, fullName: 'Prince' };

    expect(valueForCategory('first_name', mononym)).toBe('Prince');
    expect(valueForCategory('last_name', mononym)).toBeUndefined();
  });

  it('reads a cleared optional field as nothing to fill, not as an empty string', () => {
    // The Profile stores a cleared optional as `null` (see `options/App.tsx`'s `orNull`), and the
    // Fill Step must skip the field rather than write "" over whatever the page already had.
    const sparse = {
      ...profile,
      phone: null,
      location: null,
      links: { linkedin: null, portfolio: null, github: null },
    };

    expect(valueForCategory('phone', sparse)).toBeUndefined();
    expect(valueForCategory('location', sparse)).toBeUndefined();
    expect(valueForCategory('linkedin_url', sparse)).toBeUndefined();
  });

  it('has no value for a category the Profile does not back', () => {
    const notFromProfile: FieldCategory[] = [
      'question',
      'resume_upload',
      'cover_letter_text',
      'cover_letter_upload',
      'unknown',
    ];

    for (const category of notFromProfile) {
      expect(valueForCategory(category, profile)).toBeUndefined();
    }
  });
});
