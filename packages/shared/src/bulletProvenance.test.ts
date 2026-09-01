import { describe, expect, it } from 'vitest';
import { bulletProvenance, matchBulletSource, sourceRoleFor } from './bulletProvenance.js';
import type { Profile, TailoredResume } from './schemas.js';

describe('matchBulletSource', () => {
  it('reports a verbatim match when the tailored bullet is exactly a Profile bullet', () => {
    const source = 'Led the billing service migration';

    expect(matchBulletSource(source, ['Owned on-call', source])).toEqual({
      verdict: 'verbatim',
      source,
    });
  });

  it('reports the closest word-overlap Profile bullet as reworded when the text differs', () => {
    const source = 'Led the billing service migration off the legacy vendor';
    const rewrite = 'Led a billing service migration away from the legacy vendor';

    expect(matchBulletSource(rewrite, ['Owned on-call', source])).toEqual({
      verdict: 'reworded',
      source,
    });
  });

  it('prefers the Profile bullet with the higher word overlap', () => {
    const weak = 'Owned the on-call rotation for the platform team';
    const strong = 'Migrated the billing service off the legacy vendor';
    const rewrite = 'Migrated billing off the legacy vendor';

    expect(matchBulletSource(rewrite, [weak, strong]).source).toBe(strong);
  });

  it('reports unmatched when nothing in the role shares any word with the bullet', () => {
    expect(
      matchBulletSource('Shipped the new onboarding flow', ['Owned on-call rotation']),
    ).toEqual({ verdict: 'unmatched', source: null });
  });

  it('reports unmatched for an empty source list', () => {
    expect(matchBulletSource('Anything', [])).toEqual({ verdict: 'unmatched', source: null });
  });

  it('reports unmatched rather than reworded when only one weak, coincidental word is shared', () => {
    // "team" is the only shared content word between an unrelated bullet and this one — not enough
    // to attribute the tailored bullet's origin to it.
    expect(
      matchBulletSource('Shipped a new onboarding flow for the growth team', [
        'Owned the on-call rotation for the platform team',
      ]),
    ).toEqual({ verdict: 'unmatched', source: null });
  });
});

describe('bulletProvenance', () => {
  function profile(workExperience: Profile['workExperience']): Pick<Profile, 'workExperience'> {
    return { workExperience };
  }

  function role(
    overrides: Partial<Profile['workExperience'][number]> = {},
  ): Profile['workExperience'][number] {
    return {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: [],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
      ...overrides,
    };
  }

  function resume(workExperience: TailoredResume['workExperience']): TailoredResume {
    return { skills: [], workExperience };
  }

  it('pairs each bullet with its role, in resume order', () => {
    const sourceBullet = 'Led the billing service migration';
    const result = bulletProvenance(
      resume([{ ...role(), endDate: null, bullets: [sourceBullet] }]),
      profile([role({ bullets: [sourceBullet] })]),
    );

    expect(result).toEqual([
      {
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        bullet: sourceBullet,
        verdict: 'verbatim',
        source: sourceBullet,
      },
    ]);
  });

  it('pairs a role by company/title/startDate rather than array index, so a suppressed earlier role does not misalign later ones', () => {
    const sourceBullet = 'Owned the on-call rotation';
    const secondRole = role({
      company: 'Beta Corp',
      title: 'Engineer',
      startDate: '2019-01',
      bullets: [sourceBullet],
    });
    const result = bulletProvenance(
      // Only the second role survived suppression — it is now index 0 in the resume.
      resume([{ ...secondRole, bullets: [sourceBullet] }]),
      // The Profile still lists both roles, in their original order.
      profile([role({ bullets: ['Led the billing service migration'] }), secondRole]),
    );

    expect(result).toEqual([
      {
        company: 'Beta Corp',
        title: 'Engineer',
        bullet: sourceBullet,
        verdict: 'verbatim',
        source: sourceBullet,
      },
    ]);
  });

  it('reports unmatched, with role context, for a role the Profile no longer has', () => {
    const result = bulletProvenance(
      resume([{ ...role({ company: 'Gone Corp' }), bullets: ['Anything'] }]),
      profile([]),
    );

    expect(result).toEqual([
      {
        company: 'Gone Corp',
        title: 'Senior Software Engineer',
        bullet: 'Anything',
        verdict: 'unmatched',
        source: null,
      },
    ]);
  });

  it('flattens every role’s bullets into one list', () => {
    const result = bulletProvenance(
      resume([
        { ...role({ bullets: ['First'] }) },
        { ...role({ company: 'Beta', bullets: ['Second', 'Third'] }) },
      ]),
      profile([]),
    );

    expect(result.map((entry) => entry.bullet)).toEqual(['First', 'Second', 'Third']);
  });

  it('returns an empty list for a resume with no work experience', () => {
    expect(bulletProvenance(resume([]), profile([]))).toEqual([]);
  });

  it('declines to pair a role when two Profile roles share company, title and startDate', () => {
    // A rehire, or two stints known only to year precision. Binding to whichever one `.find()`
    // happens to hit first would misattribute the wrong role's bullets as this bullet's source.
    const ambiguous = role({ bullets: ['Led the billing service migration'] });
    const result = bulletProvenance(
      resume([{ ...role(), bullets: ['Led the billing service migration'] }]),
      profile([ambiguous, { ...ambiguous, bullets: ['Owned the on-call rotation'] }]),
    );

    expect(result).toEqual([
      {
        company: 'Acme Corp',
        title: 'Senior Software Engineer',
        bullet: 'Led the billing service migration',
        verdict: 'unmatched',
        source: null,
      },
    ]);
  });
});

describe('sourceRoleFor', () => {
  function role(
    overrides: Partial<Profile['workExperience'][number]> = {},
  ): Profile['workExperience'][number] {
    return {
      company: 'Acme Corp',
      title: 'Senior Software Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: [],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
      ...overrides,
    };
  }

  it('finds the unique role matching company, title and startDate', () => {
    const target = role({ bullets: ['Owned the on-call rotation'] });
    expect(
      sourceRoleFor(target, { workExperience: [role({ company: 'Other' }), target] }),
    ).toEqual(target);
  });

  it('returns undefined when two roles are ambiguous rather than guessing', () => {
    const first = role();
    const second = role();
    expect(sourceRoleFor(first, { workExperience: [first, second] })).toBeUndefined();
  });
});
