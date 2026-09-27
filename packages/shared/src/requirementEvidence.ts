/**
 * Requirement-to-Evidence Matching: whether each posting requirement is evidenced by the Tailored
 * Resume, only by a bare skill, only by a Profile bullet this resume dropped, uncertainly, or not
 * at all. Like `keywordCoverage.ts`: deterministic, no model call, a report and never a correction.
 *
 * - Reads only `workExperience` and `skills` (all a {@link TailoredResume} carries), so an
 *   education-only requirement reads `unsupported` — a false negative, never a false claim.
 * - Years are summed over the Profile's dated roles without deduping overlaps. An unparsable date
 *   yields `needs-confirmation`, never "not enough years".
 */
import { containsAsWords, normalizeLabel } from './labelMatching.js';
import { IMPORTANCE_BANDS } from './schemas.js';
import type {
  JobInfo,
  JobRequirement,
  Profile,
  RequirementImportance,
  TailoredResume,
} from './schemas.js';

/**
 * What the Profile and this resume show for one requirement.
 *
 * - `direct-evidence` — a resume bullet supports it (or, for a years-only requirement, the years).
 * - `skill-only` — only the skills list names it.
 * - `omitted-profile-evidence` — a Profile bullet supports it, but this resume dropped that bullet.
 * - `needs-confirmation` — some signal, not enough to call it either way.
 * - `unsupported` — nothing in the Profile speaks to it.
 */
export type RequirementEvidenceVerdict =
  | 'direct-evidence'
  | 'skill-only'
  | 'omitted-profile-evidence'
  | 'needs-confirmation'
  | 'unsupported';

/** One posting requirement, and what the Profile/resume pair has to show for it. */
export interface RequirementEvidence {
  requirement: JobRequirement;
  verdict: RequirementEvidenceVerdict;
  /** The matched bullet or skill, if the verdict came from one; `null` otherwise. */
  evidence: string | null;
}

/**
 * Requirement phrasing with no domain signal, so "5+ years of experience building systems" and
 * "experience building systems" score alike. Separate from `labelMatching.ts`'s question stopwords.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'building',
  'experience',
  'for',
  'have',
  'in',
  'is',
  'of',
  'on',
  'or',
  'strong',
  'the',
  'to',
  'with',
  'working',
  'year',
  'years',
]);

/** The requirement's content words — lowercased, deduped, stopwords and short tokens dropped. */
function contentTerms(text: string): string[] {
  return Array.from(
    new Set(
      normalizeLabel(text)
        .split(/[^a-z0-9+]+/)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
    ),
  );
}

/** Share of `terms` that must appear in a candidate list to call it confidently evidenced. */
const DIRECT_EVIDENCE_RATIO = 0.6;

function findMatch(candidates: string[], terms: string[]): string | null {
  for (const term of terms) {
    const match = candidates.find((candidate) => containsAsWords(normalizeLabel(candidate), term));
    if (match) return match;
  }
  return null;
}

function hitRatio(terms: string[], candidates: string[]): number {
  if (terms.length === 0) return 0;
  const hits = terms.filter((term) =>
    candidates.some((candidate) => containsAsWords(normalizeLabel(candidate), term)),
  );
  return hits.length / terms.length;
}

/** The text-only verdict, ignoring `yearsOfExperience`; `null` if there are no content words. */
function textVerdict(
  terms: string[],
  resumeSkills: string[],
  resumeBullets: string[],
  profileBullets: string[],
): Pick<RequirementEvidence, 'verdict' | 'evidence'> | null {
  if (terms.length === 0) return null;

  // Branches run in order, so the skill-only check already knows `bulletRatio` is under threshold;
  // don't also require it to be zero, or one stray coincidental bullet term would suppress it.
  const bulletRatio = hitRatio(terms, resumeBullets);
  if (bulletRatio >= DIRECT_EVIDENCE_RATIO) {
    return { verdict: 'direct-evidence', evidence: findMatch(resumeBullets, terms) };
  }

  const skillRatio = hitRatio(terms, resumeSkills);
  if (skillRatio >= DIRECT_EVIDENCE_RATIO) {
    return { verdict: 'skill-only', evidence: findMatch(resumeSkills, terms) };
  }

  const profileRatio = hitRatio(terms, profileBullets);
  if (profileRatio >= DIRECT_EVIDENCE_RATIO) {
    return { verdict: 'omitted-profile-evidence', evidence: findMatch(profileBullets, terms) };
  }

  if (bulletRatio > 0 || skillRatio > 0 || profileRatio > 0) {
    return {
      verdict: 'needs-confirmation',
      evidence: findMatch([...resumeBullets, ...resumeSkills, ...profileBullets], terms),
    };
  }

  return { verdict: 'unsupported', evidence: null };
}

/** "YYYY" or "YYYY-MM" to a month index; `null` if the string isn't in that shape. */
function monthIndex(date: string): number | null {
  const match = /^(\d{4})(?:-(\d{2}))?$/.exec(date.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  return year * 12 + (month - 1);
}

/**
 * Total months across the Profile's dated roles, or `null` if any date doesn't parse — never
 * silently zero, which would fail a requirement the candidate meets.
 */
function totalExperienceMonths(workExperience: Profile['workExperience']): number | null {
  const now = monthIndex(new Date().toISOString().slice(0, 7));
  let total = 0;
  for (const role of workExperience) {
    const start = monthIndex(role.startDate);
    const end = role.endDate === null ? now : monthIndex(role.endDate);
    if (start === null || end === null) return null;
    total += Math.max(0, end - start);
  }
  return total;
}

function evidenceFor(
  requirement: JobRequirement,
  resumeSkills: string[],
  resumeBullets: string[],
  profileBullets: string[],
  workExperience: Profile['workExperience'],
): RequirementEvidence {
  const terms = contentTerms(requirement.text);
  const text = textVerdict(terms, resumeSkills, resumeBullets, profileBullets);

  if (requirement.yearsOfExperience === null) {
    return { requirement, ...(text ?? { verdict: 'unsupported', evidence: null }) };
  }

  const totalMonths = totalExperienceMonths(workExperience);
  const requiredMonths = requirement.yearsOfExperience * 12;

  // Can't establish tenure at all — never assert a years claim either way from unreadable dates.
  if (totalMonths === null) {
    return { requirement, verdict: 'needs-confirmation', evidence: text?.evidence ?? null };
  }

  if (totalMonths < requiredMonths) {
    // Computed tenure falls short, but overlaps aren't deduped (true tenure can only be lower), so
    // a domain match here is ambiguous rather than cleanly unsupported.
    if (text && text.verdict !== 'unsupported') {
      return { requirement, verdict: 'needs-confirmation', evidence: text.evidence };
    }
    return { requirement, verdict: 'unsupported', evidence: null };
  }

  // Years met. A years-only requirement is direct evidence; otherwise never downgrade a met years
  // bar to unsupported just because the domain wording overlapped weakly.
  if (!text) return { requirement, verdict: 'direct-evidence', evidence: null };
  if (text.verdict === 'unsupported') {
    return { requirement, verdict: 'needs-confirmation', evidence: null };
  }
  return { requirement, ...text };
}

/**
 * Band sort order, derived from the declared order in `schemas.ts`. Unbanded requirements sort
 * after every banded one (`UNBANDED_RANK`), matching the dashboard — interleaving them would
 * state a priority nothing assessed.
 */
const BAND_ORDER: Record<RequirementImportance, number> = Object.fromEntries(
  IMPORTANCE_BANDS.map((band, index) => [band, index]),
) as Record<RequirementImportance, number>;

const UNBANDED_RANK = IMPORTANCE_BANDS.length;

/** Verdicts worst first, so a band's gaps sit above what's already covered. */
const VERDICT_ORDER: Record<RequirementEvidenceVerdict, number> = {
  unsupported: 0,
  'needs-confirmation': 1,
  'omitted-profile-evidence': 2,
  'skill-only': 3,
  'direct-evidence': 4,
};

function bandRank(requirement: JobRequirement): number {
  return requirement.importance === null ? UNBANDED_RANK : BAND_ORDER[requirement.importance];
}

/**
 * Every requirement in `jobInfo` with its evidence, ordered by band (unassessed last), then unmet
 * before met, then posting order. The unmet-first tiebreak serves the tailoring model's selection
 * budget; the dashboard keeps posting order within a band instead.
 *
 * `resume` and `profile` are separate so a bullet the resume dropped
 * (`omitted-profile-evidence`) differs from one the Profile never had.
 */
export function requirementEvidence(
  resume: TailoredResume,
  jobInfo: Pick<JobInfo, 'requirements'>,
  profile: Pick<Profile, 'workExperience'>,
): RequirementEvidence[] {
  const resumeBullets = resume.workExperience.flatMap((role) => role.bullets);
  const profileBullets = profile.workExperience.flatMap((role) => role.bullets);

  return jobInfo.requirements
    .map((requirement) =>
      evidenceFor(
        requirement,
        resume.skills,
        resumeBullets,
        profileBullets,
        profile.workExperience,
      ),
    )
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        bandRank(a.entry.requirement) - bandRank(b.entry.requirement) ||
        VERDICT_ORDER[a.entry.verdict] - VERDICT_ORDER[b.entry.verdict] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}
