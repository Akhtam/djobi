import { describe, expect, it } from 'vitest';
import { keywordCoverage } from './keywordCoverage.js';
import type { JobInfo, Profile, TailoredResume } from './schemas.js';

function jobInfo(keywords: string[]): JobInfo {
  return {
    company: 'Acme',
    team: null,
    roleTitle: 'Backend Engineer',
    seniority: null,
    location: null,
    requirements: [],
    keywords: keywords.map((term) => ({ term, category: null })),
  };
}

function resume(overrides: Partial<TailoredResume> = {}): TailoredResume {
  return {
    skills: [],
    workExperience: [],
    ...overrides,
  };
}

function role(bullets: string[]): TailoredResume['workExperience'][number] {
  return {
    company: 'Checkr',
    title: 'Full-Stack Developer',
    startDate: '2022-08',
    endDate: '2024-06',
    bullets,
  };
}

function sourceProfile(bullets: string[] = []): Pick<Profile, 'workExperience'> {
  return {
    workExperience:
      bullets.length === 0 ? [] : [{ ...role(bullets), maxBullets: null, starredIndices: [] }],
  };
}

function coverage(resumeValue: TailoredResume, job: JobInfo, sourceBullets: string[] = []) {
  return keywordCoverage(resumeValue, job, sourceProfile(sourceBullets));
}

describe('keywordCoverage', () => {
  it('reports a keyword the skills list carries, naming the skill as the evidence', () => {
    const [entry] = coverage(resume({ skills: ['PostgreSQL'] }), jobInfo(['PostgreSQL']));

    expect(entry).toEqual({ keyword: 'PostgreSQL', verdict: 'skills', evidence: 'PostgreSQL' });
  });

  it('reports a keyword only a bullet carries, naming the whole bullet as the evidence', () => {
    const bullet = 'Improved API response times by 75% by adding Redis caching';
    const [entry] = coverage(resume({ workExperience: [role([bullet])] }), jobInfo(['Redis']));

    expect(entry).toEqual({ keyword: 'Redis', verdict: 'experience', evidence: bullet });
  });

  it('prefers the skills list when both carry the keyword, because that is where a recruiter filter looks first', () => {
    const [entry] = coverage(
      resume({ skills: ['Redis'], workExperience: [role(['Added Redis caching'])] }),
      jobInfo(['Redis']),
    );

    expect(entry.verdict).toBe('skills');
  });

  it('reports a keyword nothing carries as missing, with no evidence to show for it', () => {
    const [entry] = coverage(resume({ skills: ['Redis'] }), jobInfo(['Kubernetes']));

    expect(entry).toEqual({ keyword: 'Kubernetes', verdict: 'missing', evidence: null });
  });

  it('ignores case, the one difference between a posting’s spelling and a profile’s that is not a difference', () => {
    const [entry] = coverage(resume({ skills: ['typescript'] }), jobInfo(['TypeScript']));

    expect(entry.verdict).toBe('skills');
  });

  it('does not let a short keyword match a longer word that merely starts with it', () => {
    const result = coverage(
      resume({ skills: ['React'], workExperience: [role(['Built services in Google Cloud'])] }),
      jobInfo(['R', 'Go']),
    );

    expect(result.map((entry) => entry.verdict)).toEqual(['missing', 'missing']);
  });

  it('matches a keyword that ends a bullet or is followed by punctuation, where a naive boundary check fails', () => {
    const result = coverage(
      resume({ workExperience: [role(['Migrated the fleet to Kubernetes.', 'Owned CI/CD'])] }),
      jobInfo(['Kubernetes', 'CI/CD']),
    );

    expect(result.map((entry) => entry.verdict)).toEqual(['experience', 'experience']);
  });

  it('keeps the posting’s own spelling of the keyword, since that is the word the report is about', () => {
    const [entry] = coverage(resume({ skills: ['typescript'] }), jobInfo(['TypeScript']));

    expect(entry.keyword).toBe('TypeScript');
  });

  it('reports every keyword once, in the order the posting listed them', () => {
    const result = coverage(
      resume({ skills: ['Redis'] }),
      jobInfo(['Kubernetes', 'Redis', 'Terraform']),
    );

    expect(result.map((entry) => entry.keyword)).toEqual(['Kubernetes', 'Redis', 'Terraform']);
  });

  it('returns nothing for a posting whose extraction found no keywords, rather than an empty-looking report', () => {
    expect(coverage(resume({ skills: ['Redis'] }), jobInfo([]))).toEqual([]);
  });

  it('skips a blank keyword, which would otherwise match every bullet and read as covered', () => {
    expect(coverage(resume({ skills: ['Redis'] }), jobInfo(['  ']))).toEqual([]);
  });

  it('reports a keyword found only in Profile experience and names what to star', () => {
    const sourceBullet = 'Provisioned Kubernetes clusters with Terraform';
    const [entry] = coverage(
      resume({ workExperience: [role(['Led incident response'])] }),
      jobInfo(['Kubernetes']),
      [sourceBullet, 'Led incident response'],
    );

    expect(entry).toEqual({
      keyword: 'Kubernetes',
      verdict: 'profile-experience',
      evidence: sourceBullet,
    });
  });

  it('still prefers tailored evidence over a matching source bullet', () => {
    const [entry] = coverage(
      resume({ workExperience: [role(['Operated Kubernetes in production'])] }),
      jobInfo(['Kubernetes']),
      ['Provisioned Kubernetes clusters'],
    );

    expect(entry.verdict).toBe('experience');
  });
});
