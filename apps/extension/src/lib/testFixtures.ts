/**
 * Neutral domain fixtures shared by the extension's tests: an empty Profile, one job, and a
 * tailored resume. Deliberately **empty**, so each test spreads in what it's about (`{ ...profile,
 * skills: ['TypeScript'] }`). Not shipped; re-exported by `panel/panelTestHarness.ts`.
 */
import type { JobInfo, Profile, TailoredResume } from '@djobi/shared';
import type { PipelineRunState } from './run';

export const profile: Profile = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

export const jobInfo: JobInfo = {
  company: 'Acme',
  team: null,
  roleTitle: 'Senior Engineer',
  seniority: 'Senior',
  location: null,
  requirements: [],
  keywords: [],
};

export const tailoredResume: TailoredResume = { skills: [], workExperience: [] };

/** A fresh neutral run, with overrides for the one fact a test is about. */
export function pipelineRunFixture(overrides: Partial<PipelineRunState> = {}): PipelineRunState {
  return {
    runId: 'run-1',
    status: 'review',
    tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    jobPageData: { fields: [] },
    jobDescription: 'Senior Engineer at Acme...',
    analyzedJobDescription: 'Senior Engineer at Acme...',
    jobInfo: { ...jobInfo, requirements: [], keywords: [] },
    tailoredResume: { skills: [], workExperience: [] },
    answers: [],
    coverage: [],
    failure: null,
    unresolvedRequiredFields: [],
    filledFieldCount: 0,
    fillOutcome: null,
    applicationId: null,
    duplicateOf: null,
    ...overrides,
  };
}
