/**
 * The candidate's chance to accept, edit, reorder or reject what `tailorResume` selected — before
 * it reaches Fill.
 *
 * `bulletTruthfulness.ts` already guarantees every bullet here traces to a real Profile sentence,
 * reverted to it verbatim wherever a rewrite invented a number or a named specific. What this adds
 * is judgment the backend cannot supply: whether a *truthful* rewrite still reads right, whether a
 * bullet belongs in this posting's resume at all, and which of a role's bullets should lead. Every
 * control here edits a plain in-memory `TailoredResume`; nothing is destructive until `onChange`
 * writes it back to the run.
 *
 * Source pairing (`matchBulletSource.ts`) is necessarily a best-effort *reading* — `sourceIndex`
 * pointers exist only inside `tailorResume.ts` and never reach the wire — so a bullet the candidate
 * typed here from scratch, with no Profile bullet resembling it, shows no "originally" line. That is
 * an honest gap, not a bug: this module cannot claim a trace it does not have.
 */
import { matchBulletSource, sourceRoleFor, type Profile, type TailoredResume } from '@djobi/shared';

function moveWithin<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * @param tailoredResume - The run's current resume; edits are relative to this.
 * @param profile - Where "originally: …" and "revert" pull their text from.
 * @param editable - Whether controls are live. `false` while a fill/save is in flight, matching
 *   the answer cards' own `editEnabled` gate — the run must not change under a request already using it.
 * @param onChange - Called with the whole edited resume; the caller decides how to persist it.
 */
export function ResumeReview({
  tailoredResume,
  profile,
  editable,
  onChange,
}: {
  tailoredResume: TailoredResume;
  profile: Profile;
  editable: boolean;
  onChange: (next: TailoredResume) => void;
}) {
  const totalBullets = tailoredResume.workExperience.reduce(
    (sum, role) => sum + role.bullets.length,
    0,
  );

  function updateRole(roleIndex: number, updateBullets: (bullets: string[]) => string[]) {
    const workExperience = tailoredResume.workExperience.map((role, index) =>
      index === roleIndex ? { ...role, bullets: updateBullets(role.bullets) } : role,
    );
    onChange({ ...tailoredResume, workExperience });
  }

  // A capped resume, or one whose bullets all got reverted or dropped, can legitimately land here
  // with nothing to show. Staying visible (and open) rather than rendering nothing is the point:
  // this is exactly the case where the candidate needs to see, before Fill, that the resume about
  // to be attached carries no bullets at all.
  return (
    <details className="resume-review" open={totalBullets === 0 ? true : undefined}>
      <summary className="eyebrow">Review resume bullets</summary>
      <div className="resume-review-content">
        {totalBullets === 0 ? (
          <p className="hint">
            No resume bullets remain for this posting — Fill will attach a resume with no experience
            bullets. Check your Profile's bullets for this job, or the per-role bullet limit.
          </p>
        ) : (
          <p className="hint">
            Edit, reorder or remove any bullet below — Fill uses exactly what's here. A rewrite that
            named a number or a technology your Profile doesn't already say has already been swapped
            back to your own wording.
          </p>
        )}
        {tailoredResume.workExperience.map((role, roleIndex) => {
          if (role.bullets.length === 0) return null;
          const sourceBullets = sourceRoleFor(role, profile)?.bullets ?? [];

          return (
            <div className="resume-review-role" key={`${role.company}-${role.title}-${roleIndex}`}>
              <span className="resume-review-role-title">
                {role.title} at {role.company}
              </span>
              <ul className="resume-review-bullets">
                {role.bullets.map((bullet, bulletIndex) => {
                  const match = matchBulletSource(bullet, sourceBullets);
                  const n = bulletIndex + 1;
                  return (
                    <li className="resume-review-bullet" key={bulletIndex}>
                      <textarea
                        aria-label={`Role ${roleIndex + 1} bullet ${n}`}
                        value={bullet}
                        disabled={!editable}
                        onChange={(e) =>
                          updateRole(roleIndex, (bullets) =>
                            bullets.map((b, i) => (i === bulletIndex ? e.target.value : b)),
                          )
                        }
                      />
                      {match.verdict === 'reworded' && (
                        <div className="resume-review-source">
                          <span className="resume-review-source-label">
                            Originally: {match.source}
                          </span>
                          <button
                            type="button"
                            className="btn-link"
                            disabled={!editable}
                            onClick={() =>
                              updateRole(roleIndex, (bullets) =>
                                bullets.map((b, i) => (i === bulletIndex ? match.source : b)),
                              )
                            }
                          >
                            Revert to original
                          </button>
                        </div>
                      )}
                      <div className="resume-review-bullet-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={`Move role ${roleIndex + 1} bullet ${n} up`}
                          disabled={!editable || bulletIndex === 0}
                          onClick={() =>
                            updateRole(roleIndex, (bullets) => moveWithin(bullets, bulletIndex, -1))
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={`Move role ${roleIndex + 1} bullet ${n} down`}
                          disabled={!editable || bulletIndex === role.bullets.length - 1}
                          onClick={() =>
                            updateRole(roleIndex, (bullets) => moveWithin(bullets, bulletIndex, 1))
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          aria-label={`Remove role ${roleIndex + 1} bullet ${n}`}
                          disabled={!editable}
                          onClick={() =>
                            updateRole(roleIndex, (bullets) =>
                              bullets.filter((_, i) => i !== bulletIndex),
                            )
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </details>
  );
}
