import { bulletProvenance } from './bulletProvenance.js';
import { requirementEvidence } from './requirementEvidence.js';
import {
  baseResumeOf,
  EXTRACTION_VERSION,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
  type QuestionAnswer,
  type TailoredResume,
} from './schemas.js';

/**
 * The fields common to every Application write path, `source` excepted. `requirementEvidence` and
 * `bulletProvenance` are computed against the *stored* resume, not the whole Profile.
 */

/** What a manual Application (Log tab / dashboard "Log an application") is built from. */
export interface ManualApplicationSource {
  jobUrl: string;
  jobDescription: string;
  jobInfo: JobInfo;
  /** The candidate's edits to the extracted company/role — win over the extraction's own values. */
  company: string;
  roleTitle: string;
}

/**
 * A manual Application's payload: the whole Profile as the stored resume and no drafted answers.
 * `company`/`roleTitle` overrides apply both to the top-level columns and inside `jobInfo`, so a
 * correction shows everywhere. Strings are trimmed here, not trusted from the caller.
 */
export function manualApplicationPayload(
  profile: Profile,
  source: ManualApplicationSource,
): NewApplicationRequest {
  const company = source.company.trim();
  const roleTitle = source.roleTitle.trim();
  const jobUrl = source.jobUrl.trim();
  const resume = baseResumeOf(profile);
  const jobInfo: JobInfo = { ...source.jobInfo, company, roleTitle };

  return {
    company,
    roleTitle,
    jobUrl,
    jobInfo,
    tailoredResume: resume,
    answers: [],
    source: 'manual',
    rawDescription: source.jobDescription.trim(),
    requirementEvidence: requirementEvidence(resume, jobInfo, profile),
    bulletProvenance: bulletProvenance(resume, profile),
  };
}

/** What an autofill Application (the Application Pipeline's Save Step) is built from. */
export interface AutofillApplicationSource {
  jobInfo: JobInfo;
  tailoredResume: TailoredResume;
  answers: QuestionAnswer[];
  /** The Job Description the Analysis Step actually ran against. */
  analyzedJobDescription: string;
  /** The tab's URL at analysis time — `''` when Chrome never exposed one. */
  tabUrl: string | null;
}

/**
 * An autofill Application's payload from an analyzed run, stamped with the extraction version.
 *
 * `profile` is read fresh at save time and may be `null` (deleted, or backend briefly unreachable);
 * then `requirementEvidence`/`bulletProvenance` are stored as `null` rather than failing the save.
 */
export function autofillApplicationPayload(
  run: AutofillApplicationSource,
  profile: Profile | null,
): {
  company: string;
  roleTitle: string;
  jobUrl: string;
  jobInfo: {
    company: string;
    team: string | null;
    roleTitle: string;
    seniority: string | null;
    location: string | null;
    requirements: {
      text: string;
      kind: 'preferred' | 'required' | 'unspecified';
      yearsOfExperience: number | null;
      importance: 'critical' | 'high' | 'low-signal' | 'meaningful' | 'preferred' | null;
      importanceTier: 'inferred' | 'stated' | 'structural' | null;
      postingSignal: string | null;
    }[];
    keywords: {
      term: string;
      category: 'domain' | 'framework' | 'language' | 'platform' | 'soft-skill' | 'tool' | null;
      postingSpelling: string | null;
    }[];
  };
  tailoredResume: {
    skills: string[];
    workExperience: {
      company: string;
      title: string;
      startDate: string;
      endDate: string | null;
      bullets: string[];
    }[];
  };
  answers: { fieldId: string; question: string; answer: string; sourceStoryIds: string[] }[];
  rawDescription: string;
  extractionVersion: string;
  requirementEvidence: import('./requirementEvidence.js').RequirementEvidence[] | null;
  bulletProvenance: import('./bulletProvenance.js').BulletProvenanceEntry[] | null;
} {
  // Typed structurally, not as `NewApplicationRequest`: that wire-input shape also allows a bare
  // string requirement, which `updateApplication`'s `ApplicationSnapshot` would reject.
  return {
    company: run.jobInfo.company,
    roleTitle: run.jobInfo.roleTitle,
    jobUrl: run.tabUrl ?? '',
    jobInfo: run.jobInfo,
    tailoredResume: run.tailoredResume,
    answers: run.answers,
    rawDescription: run.analyzedJobDescription,
    extractionVersion: EXTRACTION_VERSION,
    requirementEvidence: profile
      ? requirementEvidence(run.tailoredResume, run.jobInfo, profile)
      : null,
    bulletProvenance: profile ? bulletProvenance(run.tailoredResume, profile) : null,
  };
}
