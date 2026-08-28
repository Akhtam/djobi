/**
 * Keyword Coverage: what a Tailored Resume actually evidences of a posting's keywords.
 *
 * `extractJob` pulls `JobInfo.keywords` out of a posting and `tailorResume` is told to emphasize
 * them; nothing between those two steps ever checks the result. This module is that check, and it
 * is deliberately the *only* kind of check it can honestly be — a report, not a correction.
 *
 * **Why it never feeds back into the model.** `reconcileResume` forces every tailored skill through
 * `matchOptionLabel(profile.skills, …)`, so a skill the Profile does not list cannot reach the
 * resume at all. That is correct, and it means the remedy for an uncovered keyword is always the
 * Profile — "add it if you have it" — and never the resume. A coverage number the tailoring prompt
 * were asked to raise would be a number raised by writing words the candidate cannot support, which
 * is the fabrication every other reconciliation in this codebase exists to prevent.
 *
 * **Why the resume and not the answers.** An ATS parses the attached resume into the candidate
 * record a recruiter later searches; a drafted answer to a screening question is not part of that
 * record. Widening the haystack to `QuestionAnswer[]` would make the report say "covered" about a
 * keyword no recruiter search will ever find. Not an oversight.
 *
 * **What this cannot see.** Synonyms. A Profile saying "K8s" against a posting saying "Kubernetes"
 * is reported missing, and there is no alias table to fix it: encoding one means turning
 * `JobInfoSchema.keywords` from `string[]` into objects, which lands in stored `job_info` jsonb, the
 * dashboard's rendering and every prompt's `<job_info>` block. A false "missing" costs the candidate
 * one glance at a keyword they can dismiss; a false "covered" costs them the gap they came here to
 * find. Erring toward missing is the whole reason this is worth shipping without aliases.
 */
import { containsAsWords, normalizeLabel } from './labelMatching.js';
import type { JobInfo, TailoredResume } from './schemas.js';

/** Where a keyword was found — or that it was not. */
export type CoverageVerdict = 'skills' | 'experience' | 'missing';

/** One posting keyword, and what the Tailored Resume has to show for it. */
export interface KeywordCoverage {
  /** The posting's own spelling, since that is the word the report is about. */
  keyword: string;
  verdict: CoverageVerdict;
  /** The skill or the whole bullet the keyword was found in; `null` when `missing`. */
  evidence: string | null;
}

/**
 * Every keyword in `jobInfo`, in the order the posting listed them, with what `resume` evidences.
 *
 * Skills are searched before bullets and the first hit wins: a keyword present in both is reported
 * against the skills list, because that is the field an ATS indexes as a discrete term and the line
 * a recruiter's filter reads first. A blank keyword is skipped rather than matched — it is
 * contained in every bullet, so scoring it would report a resume as covering something the posting
 * never asked for.
 */
export function keywordCoverage(resume: TailoredResume, jobInfo: JobInfo): KeywordCoverage[] {
  const bullets = resume.workExperience.flatMap((entry) => entry.bullets);

  return jobInfo.keywords.flatMap((keyword): KeywordCoverage[] => {
    const needle = normalizeLabel(keyword);
    if (!needle) return [];

    const carries = (candidate: string): boolean =>
      containsAsWords(normalizeLabel(candidate), needle);

    const skill = resume.skills.find(carries);
    if (skill) return [{ keyword, verdict: 'skills', evidence: skill }];

    const bullet = bullets.find(carries);
    if (bullet) return [{ keyword, verdict: 'experience', evidence: bullet }];

    return [{ keyword, verdict: 'missing', evidence: null }];
  });
}
