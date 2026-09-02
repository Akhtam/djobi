/**
 * The neutral domain fixtures the extension's tests share: a Profile with nothing in it, one job,
 * and the resume shape tailoring produces.
 *
 * Six test modules had written the same eleven-field `Profile` literal, and five the same
 * `JobInfo` — so a field added to either meant editing every one of them, and a copy that drifted
 * would be a test asserting against a shape the app no longer has. That is the argument
 * `lib/fakeChrome.ts` and `lib/fakeSessionStorage.ts` already make for their surfaces; this is the
 * same one for the values.
 *
 * Deliberately **empty rather than representative**. These are the baseline a case starts from and
 * spreads over — `{ ...profile, skills: ['TypeScript'] }` — so what a test is actually about is
 * visible in the test rather than buried in a fixture it shares with thirty others. A case whose
 * subject *is* the content of a Profile keeps its own literal, and several do.
 *
 * Not imported by anything that ships. `panel/panelTestHarness.ts` re-exports these, so a panel
 * test keeps reaching for the one module it already knows.
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
