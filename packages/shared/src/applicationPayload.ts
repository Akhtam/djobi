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
 * Assembles a saved Application's payload — the fields common to every write path, `source`
 * excepted. Both {@link manualApplicationPayload} and {@link autofillApplicationPayload} used to be
 * built by hand at each of three call sites (the extension's Log tab, the dashboard's manual-entry
 * flow, and the Application Pipeline's Save Step); the two manual ones were byte-identical, and all
 * three had to independently remember that `requirementEvidence`/`bulletProvenance` are computed
 * against the *stored* resume, not the candidate's whole Profile.
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
 * Builds a manual Application's payload: the candidate's whole Profile as the stored resume — no
 * tailoring happened, so there is nothing to select down to — and no drafted answers, since the
 * candidate wrote whatever they wrote themselves. `company`/`roleTitle` win over the extraction's
 * own values both as the top-level columns and inside the stored `jobInfo`, so a correction applies
 * everywhere a row reads them, not just where it's displayed.
 *
 * Every string field is trimmed here rather than trusted from the caller, so a future call site
 * can't reintroduce the untrimmed values both existing ones took care to avoid.
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
 * Builds an autofill Application's payload from an analyzed run: the tailored resume and drafted
 * answers the pipeline produced, stamped with the extraction version in force.
 *
 * `profile` is separate from `run` and nullable, because the Save Step reads the Profile fresh at
 * save time rather than threading it from Analysis — the record a save should be judged against is
 * the one that exists *now*. A Profile that can't be read (deleted, or the backend briefly
 * unreachable between Fill and Save) is not load-bearing: `requirementEvidence`/`bulletProvenance`
 * go in `null` rather than failing a write the candidate is actively waiting on.
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
  // The return type is spelled out structurally rather than named `NewApplicationRequest`:
  // `run.jobInfo` is already the parsed `JobInfo` (not `NewApplicationRequest`'s wire-input shape,
  // which additionally allows a requirement as a bare string). Naming `NewApplicationRequest` would
  // widen `jobInfo.requirements` to that union and break this payload's use for
  // `updateApplication`, whose `ApplicationSnapshot` accepts only the parsed shape. The parsed shape
  // written out here stays assignable to both.
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
