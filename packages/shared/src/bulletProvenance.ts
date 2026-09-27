/**
 * Bullet Provenance: pairs each Tailored Resume bullet with the Profile bullet it most likely came
 * from, for the review panel and the persisted `Application.bulletProvenance`.
 *
 * Best-effort: `sourceIndex` never leaves the backend, so this re-reads plain strings. A verbatim
 * match is exact; otherwise the closest word overlap among that role's Profile bullets wins.
 */
import { containsAsWords, normalizeLabel, uniqueMatch } from './labelMatching.js';
import type { Profile, TailoredResume } from './schemas.js';

export type BulletProvenanceVerdict = 'verbatim' | 'reworded' | 'unmatched';

export type BulletSourceMatch =
  | { verdict: 'verbatim'; source: string }
  | { verdict: 'reworded'; source: string }
  | { verdict: 'unmatched'; source: null };

/** One resume bullet, with role context, as persisted on `Application.bulletProvenance`. */
export interface BulletProvenanceEntry {
  company: string;
  title: string;
  bullet: string;
  verdict: BulletProvenanceVerdict;
  source: string | null;
}

// Plain 3+-letter word overlap, not `labelMatching.ts`'s stemmed matcher: bullets are full
// sentences, so stemming and stopwords (tuned for short form questions) add nothing.
function contentWords(text: string): string[] {
  return normalizeLabel(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

/** Below this share of the tailored bullet's words, a match is too thin to call "reworded". */
const OVERLAP_THRESHOLD = 0.5;
/** Fewer shared words than this is a coincidence, whatever the ratio says. */
const MIN_SHARED_WORDS = 2;

function overlapScore(bullet: string, candidate: string): { score: number; sharedWords: number } {
  const words = contentWords(bullet);
  if (words.length === 0) return { score: 0, sharedWords: 0 };
  const sharedWords = words.filter((word) =>
    containsAsWords(normalizeLabel(candidate), word),
  ).length;
  return { score: sharedWords / words.length, sharedWords };
}

/**
 * @param tailoredBullet - One bullet as it appears on the tailored resume.
 * @param profileBullets - The candidate's authored bullets for the *same role* — order-independent,
 *   since a tailored resume may have reordered them.
 */
export function matchBulletSource(
  tailoredBullet: string,
  profileBullets: string[],
): BulletSourceMatch {
  const verbatim = profileBullets.find((source) => source === tailoredBullet);
  if (verbatim) return { verdict: 'verbatim', source: verbatim };

  let best: { source: string; score: number } | null = null;
  for (const source of profileBullets) {
    const { score, sharedWords } = overlapScore(tailoredBullet, source);
    // One shared word is coincidence, not evidence of a rewording.
    if (sharedWords < MIN_SHARED_WORDS || score < OVERLAP_THRESHOLD) continue;
    if (!best || score > best.score) best = { source, score };
  }
  return best
    ? { verdict: 'reworded', source: best.source }
    : { verdict: 'unmatched', source: null };
}

/**
 * The Profile role that authored `role`'s bullets, matched by company + title + startDate (not
 * index — `suppressIfEmpty` can drop roles). Ambiguous matches (e.g. a rehire) return `undefined`
 * rather than misattributing bullets.
 */
export function sourceRoleFor(
  role: Pick<TailoredResume['workExperience'][number], 'company' | 'title' | 'startDate'>,
  profile: Pick<Profile, 'workExperience'>,
): Profile['workExperience'][number] | undefined {
  return uniqueMatch(
    profile.workExperience,
    (candidate) =>
      candidate.company === role.company &&
      candidate.title === role.title &&
      candidate.startDate === role.startDate,
  );
}

/**
 * Every bullet on `resume` paired with its likely Profile source, roles matched as in
 * {@link sourceRoleFor}.
 */
export function bulletProvenance(
  resume: TailoredResume,
  profile: Pick<Profile, 'workExperience'>,
): BulletProvenanceEntry[] {
  return resume.workExperience.flatMap((role) => {
    const sourceBullets = sourceRoleFor(role, profile)?.bullets ?? [];

    return role.bullets.map((bullet) => ({
      company: role.company,
      title: role.title,
      bullet,
      ...matchBulletSource(bullet, sourceBullets),
    }));
  });
}
