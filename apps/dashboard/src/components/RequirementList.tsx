/**
 * One application's requirements, grouped by band (`lib/requirementGroups.ts`), with each stored
 * evidence verdict — "is *this* resume backing what *this* posting asked?". Rendering rules match
 * `RequirementsPanel`:
 *
 * - **`direct-evidence` gets no badge** (the common good case).
 * - **`omitted-profile-evidence` quotes the bullet** — it names a fix.
 * - **No stored verdicts renders plainly** — "nothing checked", never "nothing found".
 *
 * The row budget is a default with a reveal, since this is the only place a posting's requirements
 * are shown; the reveal says how many are hidden, not why.
 */
import { useState } from 'react';
import type { JobRequirement, RequirementEvidenceEntry } from '@djobi/shared';
import { BAND_LABELS, groupByImportance } from '../lib/requirementGroups';
import { EVIDENCE_LABELS } from '../lib/stages';

export function RequirementList({
  requirements,
  evidence,
}: {
  requirements: readonly JobRequirement[];
  /** Verdicts keyed by requirement text — empty for a row saved before they were computed. */
  evidence: Map<string, RequirementEvidenceEntry>;
}) {
  const [showAll, setShowAll] = useState(false);
  const { groups, hiddenCount } = groupByImportance(requirements, showAll ? Infinity : undefined);

  return (
    <div className="requirement-groups">
      {groups.map(({ key, requirements: group }) => (
        <section key={key} className={`requirement-group requirement-group--${key}`}>
          <h4 className={`requirement-group__title requirement-band requirement-band--${key}`}>
            {BAND_LABELS[key]}
          </h4>
          <ul className="bullets requirement-group__items">
            {group.map((requirement) => {
              const verdict = evidence.get(requirement.text);
              return (
                <li key={requirement.text}>
                  {requirement.text}
                  {requirement.yearsOfExperience !== null ? (
                    <span className="requirement-years">
                      {' '}
                      ({requirement.yearsOfExperience}+ yrs)
                    </span>
                  ) : null}
                  {verdict && verdict.verdict !== 'direct-evidence' ? (
                    <span className={`requirement-verdict requirement-verdict--${verdict.verdict}`}>
                      {EVIDENCE_LABELS[verdict.verdict]}
                    </span>
                  ) : null}
                  {verdict?.verdict === 'omitted-profile-evidence' && verdict.evidence ? (
                    <span className="requirement-omitted">
                      Your profile has: “{verdict.evidence}”
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="requirement-groups__trimmed"
          onClick={() => setShowAll(true)}
        >
          Show {hiddenCount} more requirement{hiddenCount === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}
