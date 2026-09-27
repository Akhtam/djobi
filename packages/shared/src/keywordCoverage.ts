/**
 * Keyword Coverage: what a Tailored Resume evidences of a posting's `JobInfo.keywords`.
 *
 * A report for the candidate, never fed back to the model: `reconcileResume` already forces skills
 * through the Profile, so the only honest remedies for a gap are starring a bullet that evidences
 * it or adding a fact the candidate really has. Feeding a score back would reward fabrication.
 *
 * - Searches the resume only, not answers: the resume is what an ATS indexes for recruiter search.
 * - No synonym table. The one exception is a term's own `postingSpelling` (e.g. "K8s" for
 *   "Kubernetes"), which extraction already captured. Erring toward "missing" is deliberate — a
 *   false "covered" hides the gap the candidate came to find.
 */
import { containsAsWords, normalizeKeyword } from './labelMatching.js';
import type { JobInfo, Profile, TailoredResume } from './schemas.js';

/** Where a keyword was found — or that it was not. */
export type CoverageVerdict = 'skills' | 'experience' | 'profile-experience' | 'missing';

/** One posting keyword, and what the Tailored Resume has to show for it. */
export interface KeywordCoverage {
  /** The posting's own spelling, since that is the word the report is about. */
  keyword: string;
  verdict: CoverageVerdict;
  /** The skill or the whole bullet the keyword was found in; `null` when `missing`. */
  evidence: string | null;
}

/**
 * Every keyword in `jobInfo`, in posting order, with what `resume` evidences.
 *
 * Skills are checked before bullets and the first hit wins (skills are what an ATS indexes as
 * discrete terms). Blank keywords are skipped. Only `keywords` is needed, so Analytics can pass a
 * synthesized `{ keywords }`.
 */
export function keywordCoverage(
  resume: TailoredResume,
  jobInfo: Pick<JobInfo, 'keywords'>,
  profile: Pick<Profile, 'workExperience'>,
): KeywordCoverage[] {
  const bullets = resume.workExperience.flatMap((entry) => entry.bullets);
  const sourceBullets = profile.workExperience.flatMap((entry) => entry.bullets);

  return jobInfo.keywords.flatMap(({ term: keyword, postingSpelling }): KeywordCoverage[] => {
    // Either spelling counts as evidence; the report still names the canonical `term`.
    const needles = [
      normalizeKeyword(keyword),
      postingSpelling ? normalizeKeyword(postingSpelling) : '',
    ]
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    if (needles.length === 0) return [];

    const carries = (candidate: string): boolean => {
      const normalized = normalizeKeyword(candidate);
      return needles.some((needle) => containsAsWords(normalized, needle));
    };

    const skill = resume.skills.find(carries);
    if (skill) return [{ keyword, verdict: 'skills', evidence: skill }];

    const bullet = bullets.find(carries);
    if (bullet) return [{ keyword, verdict: 'experience', evidence: bullet }];

    const sourceBullet = sourceBullets.find(carries);
    if (sourceBullet) return [{ keyword, verdict: 'profile-experience', evidence: sourceBullet }];

    return [{ keyword, verdict: 'missing', evidence: null }];
  });
}
