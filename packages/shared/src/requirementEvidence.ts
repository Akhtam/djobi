/**
 * Requirement-to-Evidence Matching: what a Tailored Resume and the Profile behind it actually show
 * for one of a posting's stated qualifications — not just whether a keyword string appears, the way
 * `keywordCoverage.ts` reports it, but whether the requirement itself is evidenced, evidenced only
 * as a bare skill with no story behind it, evidenced in the Profile but dropped from this resume,
 * uncertain, or not evidenced anywhere.
 *
 * Same discipline as `keywordCoverage.ts`, and for the same reason: deterministic, no model call, a
 * report and never a correction. `reconcileResume` already forces every tailored skill and bullet
 * through the authoritative Profile, so this module cannot add anything to a resume — it can only
 * say what's already there.
 *
 * **What this cannot see.** Education and certifications: like `keywordCoverage`, this only reads
 * `workExperience` and `skills`, because that is all a {@link TailoredResume} carries. A requirement
 * ("Bachelor's degree required") that only education could satisfy will read as `unsupported` even
 * when the candidate has it — a false negative, not a false claim, which is the same trade-off
 * `keywordCoverage.ts` makes deliberately.
 *
 * **How years are checked.** `yearsOfExperience` is compared against the Profile's own dated roles,
 * summed without deduplicating overlapping employment — two concurrent part-time roles double-count.
 * An unparsable date never resolves to "not enough years"; it resolves to `needs-confirmation`,
 * because asserting a years claim from data that couldn't be read is exactly the kind of guess this
 * app's extraction prompts already forbid on the model side.
 */
import { containsAsWords, normalizeLabel } from './labelMatching.js';
import type { JobInfo, JobRequirement, Profile, TailoredResume } from './schemas.js';

/**
 * What the Profile and this resume show for one requirement.
 *
 * - `direct-evidence` — a resume bullet (or, for a years-only requirement with no other content
 *   words, the years themselves) supports it.
 * - `skill-only` — only the skills list names it; no bullet tells the story behind it.
 * - `omitted-profile-evidence` — the Profile has a bullet for it, but this resume dropped that
 *   bullet (capped out, or not selected) — the same gap `keywordCoverage`'s `profile-experience`
 *   verdict names, one level up from a single keyword.
 * - `needs-confirmation` — some signal exists (a partial word match, or years that can't be
 *   established either way) but not enough to call it evidenced or absent.
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
 * Requirement phrasing carries no domain signal — "5+ years of experience building systems" and
 * "experience building systems" should score the same on their shared subject matter. Deliberately
 * small and scoped to this module: `labelMatching.ts`'s own stopword list serves a different
 * matching problem (two phrasings of one form question) and isn't exported for reuse here.
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

/** The requirement's own content words — lowercased, deduped, stopwords and short tokens dropped. */
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

/** The text-only verdict, ignoring `yearsOfExperience` — `null` when the requirement has no content words to check. */
function textVerdict(
  terms: string[],
  resumeSkills: string[],
  resumeBullets: string[],
  profileBullets: string[],
): Pick<RequirementEvidence, 'verdict' | 'evidence'> | null {
  if (terms.length === 0) return null;

  // Each branch below runs only once the ones above it didn't return, so by the time we reach the
  // skill-only check `bulletRatio` is already known to be under the threshold — gating again on it
  // being *exactly* zero would let a stray, unrelated bullet with a single coincidental term
  // suppress a verdict that skillRatio/profileRatio independently earn on their own.
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
 * Total months the Profile's dated roles sum to, or `null` if any role's `startDate`/`endDate`
 * doesn't parse — an unreadable total must never be silently treated as zero, since that would
 * report a requirement the candidate meets as one their own Profile fails to support.
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
    // The Profile's own dates fall short — a fact, not a guess. Still worth a human's confirmation
    // rather than a flat rejection when the domain otherwise matches: overlapping roles this module
    // doesn't dedupe could mean the true tenure is lower than computed, never higher, so a domain
    // match with short computed tenure is exactly the ambiguous case, not a clean unsupported one.
    if (text && text.verdict !== 'unsupported') {
      return { requirement, verdict: 'needs-confirmation', evidence: text.evidence };
    }
    return { requirement, verdict: 'unsupported', evidence: null };
  }

  // Years are met. Fall back to the years fact alone when the requirement stated no other content
  // words at all (e.g. "5+ years of experience"), and never downgrade a met years bar to unsupported
  // purely because the domain wording didn't overlap enough to call it direct evidence on its own.
  if (!text) return { requirement, verdict: 'direct-evidence', evidence: null };
  if (text.verdict === 'unsupported') {
    return { requirement, verdict: 'needs-confirmation', evidence: null };
  }
  return { requirement, ...text };
}

const KIND_ORDER: Record<JobRequirement['kind'], number> = {
  required: 0,
  preferred: 1,
  unspecified: 2,
};

/**
 * Every requirement in `jobInfo`, with what `resume`/`profile` evidence it — required requirements
 * first, then preferred, then unspecified, stable within each group in the order the posting listed
 * them.
 *
 * `resume` and `profile` are separate on purpose, the same split `keywordCoverage` takes: a
 * requirement a source bullet evidences but this tailored, capped resume dropped is a different fact
 * (`omitted-profile-evidence`) from one the candidate's whole Profile never evidenced at all.
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
        KIND_ORDER[a.entry.requirement.kind] - KIND_ORDER[b.entry.requirement.kind] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}
