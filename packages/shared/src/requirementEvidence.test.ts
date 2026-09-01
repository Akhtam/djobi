import { describe, expect, it } from 'vitest';
import { requirementEvidence } from './requirementEvidence.js';
import type { JobInfo, JobRequirement, Profile, TailoredResume } from './schemas.js';

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return { text: 'Some requirement', kind: 'unspecified', yearsOfExperience: null, ...overrides };
}

function jobInfo(requirements: JobRequirement[]): Pick<JobInfo, 'requirements'> {
  return { requirements };
}

function role(bullets: string[], dates: { startDate?: string; endDate?: string | null } = {}) {
  return {
    company: 'Checkr',
    title: 'Full-Stack Developer',
    startDate: dates.startDate ?? '2022-01',
    endDate: dates.endDate ?? '2024-01',
    bullets,
  };
}

function resume(overrides: Partial<TailoredResume> = {}): TailoredResume {
  return { skills: [], workExperience: [], ...overrides };
}

function sourceProfile(
  workExperience: ReturnType<typeof role>[] = [],
): Pick<Profile, 'workExperience'> {
  return {
    workExperience: workExperience.map((r) => ({ ...r, maxBullets: null, starredIndices: [] })),
  };
}

function evidence(
  resumeValue: TailoredResume,
  requirements: JobRequirement[],
  profileRoles: ReturnType<typeof role>[] = [],
) {
  return requirementEvidence(resumeValue, jobInfo(requirements), sourceProfile(profileRoles));
}

describe('requirementEvidence', () => {
  it('reports direct evidence when a resume bullet carries the requirement’s content words', () => {
    const bullet = 'Built and scaled distributed systems handling millions of events per day';
    const [entry] = evidence(resume({ workExperience: [role([bullet])] }), [
      requirement({ text: 'Experience building distributed systems' }),
    ]);

    expect(entry.verdict).toBe('direct-evidence');
    expect(entry.evidence).toBe(bullet);
  });

  it('reports skill-only when only the skills list carries it, with no bullet telling the story', () => {
    const [entry] = evidence(
      resume({
        skills: ['Kubernetes orchestration'],
        workExperience: [role(['Led incident response'])],
      }),
      [requirement({ text: 'Kubernetes orchestration experience' })],
    );

    expect(entry.verdict).toBe('skill-only');
    expect(entry.evidence).toBe('Kubernetes orchestration');
  });

  it('still reports skill-only when a bullet has weak, unrelated overlap below the direct-evidence bar', () => {
    // The bullet's only shared term is "systems" (1 of 4 requirement terms) — real, but nowhere
    // near enough to call it direct evidence. That must not suppress the skill-only verdict the
    // skills list independently earns in full.
    const [entry] = evidence(
      resume({
        skills: ['Kubernetes orchestration distributed systems'],
        workExperience: [role(['Led incident response for the systems team'])],
      }),
      [requirement({ text: 'Kubernetes orchestration for distributed systems' })],
    );

    expect(entry.verdict).toBe('skill-only');
  });

  it('reports omitted-profile-evidence when the Profile has it but this resume dropped the bullet', () => {
    const sourceBullet = 'Migrated the payments pipeline to Kafka streaming';
    const [entry] = evidence(
      resume({ workExperience: [role(['Led incident response'])] }),
      [requirement({ text: 'Kafka streaming pipeline experience' })],
      [role([sourceBullet, 'Led incident response'])],
    );

    expect(entry.verdict).toBe('omitted-profile-evidence');
    expect(entry.evidence).toBe(sourceBullet);
  });

  it('reports needs-confirmation for a partial word match too weak to call direct evidence', () => {
    const [entry] = evidence(
      resume({ workExperience: [role(['Built a data pipeline for internal analytics'])] }),
      [requirement({ text: 'Kafka streaming pipeline experience' })],
    );

    expect(entry.verdict).toBe('needs-confirmation');
  });

  it('reports unsupported when nothing in the Profile speaks to the requirement', () => {
    const [entry] = evidence(resume({ skills: ['React'] }), [
      requirement({ text: 'Kafka streaming pipeline experience' }),
    ]);

    expect(entry).toEqual({
      requirement: expect.objectContaining({ text: 'Kafka streaming pipeline experience' }),
      verdict: 'unsupported',
      evidence: null,
    });
  });

  it('prioritizes required requirements before preferred, then unspecified, preserving posting order within each', () => {
    const requirements = [
      requirement({ text: 'unspecified one', kind: 'unspecified' }),
      requirement({ text: 'preferred one', kind: 'preferred' }),
      requirement({ text: 'required one', kind: 'required' }),
      requirement({ text: 'required two', kind: 'required' }),
      requirement({ text: 'preferred two', kind: 'preferred' }),
    ];

    const result = evidence(resume(), requirements);

    expect(result.map((entry) => entry.requirement.text)).toEqual([
      'required one',
      'required two',
      'preferred one',
      'preferred two',
      'unspecified one',
    ]);
  });

  // Tenure is read from the Profile's own dated roles, not the tailored resume — a fact about the
  // candidate's career, independent of which bullets a given tailoring run kept. `reconcileResume`
  // always copies a role's dates through unchanged, so every case below gives the same role (with
  // matching dates) to both `resume` and `profile`, the way they'd actually arrive together.
  describe('yearsOfExperience', () => {
    it('reports direct-evidence when computed tenure meets the requirement and the domain also matches', () => {
      const bullet = 'Built distributed systems serving production traffic';
      const dated = role([bullet], { startDate: '2018-01', endDate: '2024-01' });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: 'Experience building distributed systems', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('direct-evidence');
    });

    it('reports direct-evidence from the years fact alone when the requirement states no other content words', () => {
      const dated = role(['Led incident response'], { startDate: '2018-01', endDate: '2024-01' });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: '5+ years', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('direct-evidence');
      expect(entry.evidence).toBeNull();
    });

    it('reports needs-confirmation when computed tenure falls short but the domain otherwise matches', () => {
      const bullet = 'Built distributed systems serving production traffic';
      const dated = role([bullet], { startDate: '2022-01', endDate: '2024-01' });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: 'Experience building distributed systems', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('needs-confirmation');
    });

    it('reports unsupported when computed tenure falls short and the domain does not match either', () => {
      const dated = role(['Led incident response'], { startDate: '2022-01', endDate: '2024-01' });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: 'Kafka streaming pipeline experience', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('unsupported');
    });

    it('reports needs-confirmation, never unsupported, when a role’s dates cannot be parsed', () => {
      const dated = role(['Led incident response'], {
        startDate: 'sometime in 2018',
        endDate: '2024-01',
      });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: '5+ years', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('needs-confirmation');
    });

    it('treats a null endDate as ongoing through today when summing tenure', () => {
      const dated = role(['Led incident response'], { startDate: '2015-01', endDate: null });
      const [entry] = evidence(
        resume({ workExperience: [dated] }),
        [requirement({ text: '5+ years', yearsOfExperience: 5 })],
        [dated],
      );

      expect(entry.verdict).toBe('direct-evidence');
    });

    it('sums tenure across multiple roles rather than reading only the first', () => {
      const first = role(['First role'], { startDate: '2015-01', endDate: '2018-01' });
      const second = role(['Second role'], { startDate: '2018-01', endDate: '2021-01' });
      const [entry] = evidence(
        resume({ workExperience: [first, second] }),
        [requirement({ text: '5+ years', yearsOfExperience: 5 })],
        [first, second],
      );

      expect(entry.verdict).toBe('direct-evidence');
    });
  });
});
