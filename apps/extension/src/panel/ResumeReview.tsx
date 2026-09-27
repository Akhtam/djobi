/**
 * The candidate's chance to accept, edit, reorder or reject tailored bullets before Fill.
 * `bulletTruthfulness.ts` already guarantees traceability; this adds judgment: does a truthful
 * rewrite read right, does a bullet belong, which should lead. Edits stay in memory until
 * `onChange`.
 *
 * "Originally: …" uses `matchBulletSource` — best-effort, since `sourceIndex` never leaves the
 * backend — so a bullet typed from scratch shows none.
 */
import { matchBulletSource, sourceRoleFor, type Profile, type TailoredResume } from '@djobi/shared';

function moveWithin<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const moved = list[index];
  const displaced = list[target];
  if (moved === undefined || displaced === undefined) return list;
  const next = [...list];
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/**
 * @param tailoredResume - The run's current resume; edits are relative to this.
 * @param profile - Source of "originally: …" and "revert" text.
 * @param editable - `false` while a fill/save is in flight, like the answer cards.
 * @param onChange - Called with the whole edited resume; the caller persists it.
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

  // Stay visible even with no bullets: the candidate should see that before Fill attaches it.
  return (
    <details className="resume-review" open={totalBullets === 0 ? true : undefined}>
      <summary className="eyebrow">Review resume bullets</summary>
      <div className="resume-review-content">
        {totalBullets === 0 ? (
          <p className="hint">
            No resume bullets remain for this posting, so Fill will attach a resume with no
            experience on it. Check the bullets on your profile for this job, and your per-role
            bullet limit.
          </p>
        ) : (
          <p className="hint">
            Edit, reorder, or remove any bullet below — Fill uses exactly what's here. If a rewrite
            claimed a number or a technology your profile doesn't mention, djobi already put your
            own wording back.
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
