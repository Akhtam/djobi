import { describe, expect, it } from 'vitest';
import {
  autofillApplicationPayload,
  manualApplicationPayload,
  type AutofillApplicationSource,
  type ManualApplicationSource,
} from './applicationPayload.js';
import { EMPTY_PROFILE, EXTRACTION_VERSION, type JobInfo, type Profile } from './schemas.js';

const jobInfo: JobInfo = {
  company: 'Acme (extracted)',
  team: null,
  roleTitle: 'Senior Engineer (extracted)',
  seniority: 'Senior',
  location: null,
  requirements: [{ text: 'TypeScript', kind: 'required', yearsOfExperience: null }],
  keywords: [],
};

const profile: Profile = {
  ...EMPTY_PROFILE,
  skills: ['TypeScript'],
  workExperience: [
    {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2022-01',
      endDate: null,
      bullets: ['Shipped TypeScript services'],
      maxBullets: null,
      starredIndices: [],
      suppressIfEmpty: false,
    },
  ],
};

describe('manualApplicationPayload', () => {
  const source: ManualApplicationSource = {
    jobUrl: '  https://boards.greenhouse.io/acme/jobs/1  ',
    jobDescription: '  Senior Engineer at Acme...  ',
    jobInfo,
    company: '  Acme  ',
    roleTitle: '  Senior Engineer  ',
  };

  it('trims every string field', () => {
    const payload = manualApplicationPayload(profile, source);
    expect(payload.company).toBe('Acme');
    expect(payload.roleTitle).toBe('Senior Engineer');
    expect(payload.jobUrl).toBe('https://boards.greenhouse.io/acme/jobs/1');
    expect(payload.rawDescription).toBe('Senior Engineer at Acme...');
  });

  it('is source: manual, with no drafted answers', () => {
    const payload = manualApplicationPayload(profile, source);
    expect(payload.source).toBe('manual');
    expect(payload.answers).toEqual([]);
  });

  it('stores the whole Profile as the resume — baseResumeOf, not a tailored selection', () => {
    const payload = manualApplicationPayload(profile, source);
    expect(payload.tailoredResume.workExperience[0].bullets).toEqual([
      'Shipped TypeScript services',
    ]);
    expect(payload.tailoredResume.skills).toEqual(['TypeScript']);
  });

  it('applies the edited company/role to jobInfo too, not just the top-level columns', () => {
    const payload = manualApplicationPayload(profile, source);
    expect(payload.jobInfo).toMatchObject({ company: 'Acme', roleTitle: 'Senior Engineer' });
    // Everything else the extraction found is preserved.
    expect(payload.jobInfo.seniority).toBe('Senior');
  });

  it('computes requirementEvidence/bulletProvenance against the stored resume', () => {
    const payload = manualApplicationPayload(profile, source);
    expect(payload.requirementEvidence).not.toBeNull();
    expect(payload.bulletProvenance).not.toBeNull();
  });
});

describe('autofillApplicationPayload', () => {
  const run: AutofillApplicationSource = {
    jobInfo,
    tailoredResume: { skills: ['TypeScript'], workExperience: profile.workExperience },
    answers: [
      { fieldId: 'f-why', question: 'Why us?', answer: 'Because TypeScript.', sourceStoryIds: [] },
    ],
    analyzedJobDescription: 'Senior Engineer at Acme...',
    tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  };

  it('leaves source unset, so the schema default (autofill) applies', () => {
    expect(autofillApplicationPayload(run, profile).source).toBeUndefined();
  });

  it("carries the run's own tailored resume and drafted answers through unchanged", () => {
    const payload = autofillApplicationPayload(run, profile);
    expect(payload.tailoredResume).toBe(run.tailoredResume);
    expect(payload.answers).toBe(run.answers);
  });

  it('stamps the current extraction version', () => {
    expect(autofillApplicationPayload(run, profile).extractionVersion).toBe(EXTRACTION_VERSION);
  });

  it('falls back to an empty jobUrl when the tab exposed none', () => {
    expect(autofillApplicationPayload({ ...run, tabUrl: null }, profile).jobUrl).toBe('');
  });

  it('reports null provenance rather than failing, when the Profile could not be read', () => {
    const payload = autofillApplicationPayload(run, null);
    expect(payload.requirementEvidence).toBeNull();
    expect(payload.bulletProvenance).toBeNull();
  });
});
