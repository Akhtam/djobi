/**
 * One application's posting requirements, grouped, with what the resume had to show for each.
 *
 * The evidence half is why this is a component rather than markup inside `ApplicationDetail`. The
 * verdicts are computed deterministically at save time (`requirementEvidence.ts`) and stored on the
 * row, and until now the only thing that read them back was the Analytics roll-up — which reports
 * across every posting and therefore answers "how am I doing", never "is *this* application's
 * resume actually backing what *this* posting asked for". That second question is what a detail
 * page is for.
 *
 * The rendering rules follow `RequirementsPanel`'s, deliberately, because they are the same
 * verdicts on the same data and a reader should not have to learn two vocabularies:
 *
 * - **`direct-evidence` gets no badge.** The good case is the common case; badging it would bury
 *   the four verdicts that mean something is wrong.
 * - **`omitted-profile-evidence` shows the bullet.** It is the one verdict that names a fix rather
 *   than a gap — the evidence exists in the Profile and this resume left it out — so the bullet is
 *   quoted rather than merely counted.
 * - **A row with no stored verdicts renders exactly as it did before they existed.** Most of the
 *   history predates the column, and an un-scored requirement must read as "nothing was checked",
 *   never as "nothing was found".
 */
import type { JobRequirement, RequirementEvidenceEntry } from '@djobi/shared';
import { EVIDENCE_LABELS } from '../lib/stages';

/**
 * Requirements split the way the posting states them. `unspecified` groups with `required`, since a
 * requirement the posting did not qualify is one it expects you to have — the distinction the
 * reader cares about is which ones are explicitly optional.
 */
function groupsOf(requirements: readonly JobRequirement[]) {
  return [
    {
      kind: 'required' as const,
      requirements: requirements.filter((requirement) => requirement.kind !== 'preferred'),
    },
    {
      kind: 'preferred' as const,
      requirements: requirements.filter((requirement) => requirement.kind === 'preferred'),
    },
  ];
}

export function RequirementList({
  requirements,
  evidence,
}: {
  requirements: readonly JobRequirement[];
  /** Verdicts keyed by requirement text — empty for a row saved before they were computed. */
  evidence: Map<string, RequirementEvidenceEntry>;
}) {
  return (
    <div className="requirement-groups">
      {groupsOf(requirements).map(({ kind, requirements: group }) =>
        group.length > 0 ? (
          <section key={kind} className={`requirement-group requirement-group--${kind}`}>
            <h4 className={`requirement-group__title requirement-kind requirement-kind--${kind}`}>
              {kind}
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
                      <span
                        className={`requirement-verdict requirement-verdict--${verdict.verdict}`}
                      >
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
        ) : null,
      )}
    </div>
  );
}
