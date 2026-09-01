/**
 * Keyword Coverage: what a Tailored Resume actually evidences of a posting's keywords.
 *
 * `extractJob` pulls `JobInfo.keywords` out of a posting and `tailorResume` is told to emphasize
 * them; nothing between those two steps ever checks the result. This module is that check, and it
 * is deliberately the *only* kind of check it can honestly be — a report, not a correction.
 *
 * **Why it never feeds back into the model.** `reconcileResume` forces every tailored skill through
 * the authoritative Profile, so a skill the Profile does not list cannot reach the resume at all.
 * An uncovered keyword therefore has one of two Profile-side remedies: star a source bullet that
 * already evidences it, or add the fact only if the candidate really has it. Coverage never edits
 * the resume or feeds back into tailoring, where raising a number would reward fabrication.
 *
 * **Why the resume and not the answers.** An ATS parses the attached resume into the candidate
 * record a recruiter later searches; a drafted answer to a screening question is not part of that
 * record. Widening the haystack to `QuestionAnswer[]` would make the report say "covered" about a
 * keyword no recruiter search will ever find. Not an oversight.
 *
 * **What this cannot see.** Synonyms in general — there is no alias table, and this module argues
 * against building one. The one exception is a term's own `postingSpelling`: `extractJob` already
 * knows a posting wrote "K8s" for what it canonicalized as "Kubernetes", so matching against both
 * spellings of that *specific* term is using data already captured, not guessing at a synonym. A
 * false "missing" still costs the candidate one glance at a keyword they can dismiss; a false
 * "covered" costs them the gap they came here to find — erring toward missing remains the reason
 * this stays a report and not a correction.
 */
import { containsAsWords, normalizeLabel } from './labelMatching.js';
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
 * Every keyword in `jobInfo`, in the order the posting listed them, with what `resume` evidences.
 *
 * Skills are searched before bullets and the first hit wins: a keyword present in both is reported
 * against the skills list, because that is the field an ATS indexes as a discrete term and the line
 * a recruiter's filter reads first. A blank keyword is skipped rather than matched — it is
 * contained in every bullet, so scoring it would report a resume as covering something the posting
 * never asked for.
 *
 * `jobInfo` only needs `keywords` — the Analytics view asks this once per distinct keyword across a
 * whole date range, against a synthesized `{ keywords: distinct }` that is not a real posting's
 * `JobInfo` and has none of its other fields to give.
 */
export function keywordCoverage(
  resume: TailoredResume,
  jobInfo: Pick<JobInfo, 'keywords'>,
  profile: Pick<Profile, 'workExperience'>,
): KeywordCoverage[] {
  const bullets = resume.workExperience.flatMap((entry) => entry.bullets);
  const sourceBullets = profile.workExperience.flatMap((entry) => entry.bullets);

  return jobInfo.keywords.flatMap(({ term: keyword, postingSpelling }): KeywordCoverage[] => {
    // Both are candidate needles for the same term — extractJob already knows they name one thing,
    // so a Profile carrying either spelling counts as evidence. The report itself still names the
    // keyword by its canonical `term`, since that is the spelling the rest of the app reads.
    const needles = [
      normalizeLabel(keyword),
      postingSpelling ? normalizeLabel(postingSpelling) : '',
    ]
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index);
    if (needles.length === 0) return [];

    const carries = (candidate: string): boolean => {
      const normalized = normalizeLabel(candidate);
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
