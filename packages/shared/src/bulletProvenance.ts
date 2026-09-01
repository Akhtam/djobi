/**
 * Bullet Provenance: pairs a Tailored Resume's bullets back to the Profile sentence each one most
 * likely came from, for display (`apps/extension/src/panel/ResumeReview.tsx`) and for the persisted
 * audit trail (`Application.bulletProvenance`, computed once at save time).
 *
 * `TailoredResume` carries plain strings — the backend's `sourceIndex` pointers exist only inside
 * `tailorResume.ts` and never reach the wire — so this is necessarily a best-effort *reading*, not an
 * authoritative trace. A verbatim match (the common case: a starred bullet, or one
 * `bulletTruthfulness.ts` reverted) is exact and unambiguous; anything else is the closest word
 * overlap among that role's Profile bullets.
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

// Deliberately not `labelMatching.ts`'s stemmed `contentWords`/`overlapScore`: those are tuned for
// two independent phrasings of one *form question*, short strings where stemming and a stopword
// list earn their keep. A resume bullet is a full sentence — plain length-3-plus word overlap
// already separates a reworded bullet from an unrelated one without that machinery.
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
  const sharedWords = words.filter((word) => containsAsWords(normalizeLabel(candidate), word)).length;
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
    // A single shared word ("the", filtered length-3 minimums aside, still things like "team" or
    // "code") is coincidence, not evidence this bullet reworded that one — see
    // `labelMatching.ts`'s `MIN_SHARED_CONTENT_WORDS` for the same reasoning applied to questions.
    if (sharedWords < MIN_SHARED_WORDS || score < OVERLAP_THRESHOLD) continue;
    if (!best || score > best.score) best = { source, score };
  }
  return best
    ? { verdict: 'reworded', source: best.source }
    : { verdict: 'unmatched', source: null };
}

/**
 * The Profile role that authored `role`'s bullets — matched by company + title + startDate, not
 * array index, since `WorkExperience.suppressIfEmpty` can drop a role from the tailored resume
 * entirely, which would shift every later index out of alignment with `profile.workExperience`.
 *
 * Two Profile roles that share all three fields (a rehire, or two stints known only to year
 * precision) are ambiguous, and {@link uniqueMatch} declines rather than guessing — binding to
 * whichever role happens to come first would misattribute that role's bullets in both the persisted
 * audit trail and the "Originally: …" panel.
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
 * Every bullet on `resume`, paired with its likely Profile source — the whole-resume form of
 * {@link matchBulletSource}, for the persisted audit trail.
 *
 * Roles are paired by company + title + startDate, not array index: `WorkExperience.suppressIfEmpty`
 * can drop a role from the tailored resume entirely, which would shift every later index out of
 * alignment with `profile.workExperience` if index were used.
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
