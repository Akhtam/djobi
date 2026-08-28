/**
 * The Requirement Fit block: how the Profile measures up to what the posting asked for.
 *
 * Shortfalls are shown when the report is opened, while everything met is collapsed behind a
 * count — the same shape as `CoverageReport` and for the same reason. The useful content here is
 * what the candidate has to decide about (apply anyway? mention it in an answer? skip this one?),
 * and a met/total ratio on screen would turn a decision aid into a score.
 *
 * Every `evidence` string reaching this component is Profile text the backend already resolved from
 * an index — see `llm/assessRequirements.ts`. A verdict it could not resolve arrived here as
 * `unmet`, so nothing rendered as met rests on a claim nobody checked.
 */
import type { RequirementFit } from '@djobi/shared';

const SHORTFALL_ORDER = { unmet: 0, partial: 1, met: 2 } as const;

export function RequirementFitReport({ fit }: { fit: RequirementFit[] }) {
  if (fit.length === 0) return null;

  const shortfalls = fit
    .filter((entry) => entry.verdict !== 'met')
    .sort((a, b) => SHORTFALL_ORDER[a.verdict] - SHORTFALL_ORDER[b.verdict]);
  const met = fit.filter((entry) => entry.verdict === 'met');

  return (
    <details className="coverage keyword-coverage">
      <summary className="eyebrow keyword-coverage-summary">What this posting asks for</summary>

      <div className="keyword-coverage-content">
        {shortfalls.length > 0 ? (
          <div className="coverage-gap">
            <p className="coverage-gap-head">
              {shortfalls.length === 1
                ? "1 requirement your profile doesn't fully show:"
                : `${shortfalls.length} requirements your profile doesn't fully show:`}
            </p>
            <ul className="coverage-list">
              {shortfalls.map((entry) => (
                <li key={entry.requirement}>
                  <span className="coverage-keyword">{entry.requirement}</span>
                  {entry.note && <span className="coverage-evidence">{entry.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="hint">Nothing in this posting looks out of reach for your profile.</p>
        )}

        {met.length > 0 && (
          <details className="coverage-group">
            <summary>
              {met.length} requirement{met.length === 1 ? '' : 's'} your profile meets
            </summary>
            <ul className="coverage-list">
              {met.map((entry) => (
                <li key={entry.requirement}>
                  <span className="coverage-keyword">{entry.requirement}</span>
                  {entry.evidence !== null && (
                    <span className="coverage-evidence">{entry.evidence}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </details>
  );
}
