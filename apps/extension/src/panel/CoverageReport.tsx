/**
 * The Keyword Coverage block: what the Tailored Resume evidences of the posting's keywords.
 *
 * Deliberately shaped as a **gap list**, not a score. The number this could be reduced to — "you
 * cover 7 of 10" — is the folklore form of "passing the ATS", and a number on screen is a number
 * the candidate will try to raise. There is only one honest way to raise this one, and it is to
 * have the skill; so the surface shows what is missing and points at the Profile, and keeps
 * everything already evidenced collapsed behind a count where it can't be read as a target.
 *
 * The remedy copy is load-bearing for the same reason `reconcileResume` takes the complete skills
 * list only from the Profile: an unsupported keyword cannot honestly be added to the resume. "Add it
 * to your profile if you have it" is the only instruction this component may give.
 */
import type { KeywordCoverage } from '@djobi/shared';

function Evidenced({ label, entries }: { label: string; entries: KeywordCoverage[] }) {
  if (entries.length === 0) return null;

  return (
    <details className="coverage-group">
      <summary>
        {entries.length} in your {label}
      </summary>
      <ul className="coverage-list">
        {entries.map((entry) => (
          <li key={entry.keyword}>
            <span className="coverage-keyword">{entry.keyword}</span>
            {entry.evidence !== null && entry.evidence !== entry.keyword && (
              <span className="coverage-evidence">{entry.evidence}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * @param coverage - The run's Keyword Coverage. Empty renders nothing at all: an empty report and a
 *   posting whose extraction found no keywords are the same state, and neither is a clean bill.
 */
export function CoverageReport({ coverage }: { coverage: KeywordCoverage[] }) {
  if (coverage.length === 0) return null;

  const missing = coverage.filter((entry) => entry.verdict === 'missing');
  const skills = coverage.filter((entry) => entry.verdict === 'skills');
  const experience = coverage.filter((entry) => entry.verdict === 'experience');

  return (
    <details className="coverage keyword-coverage">
      <summary className="eyebrow keyword-coverage-summary">
        Keywords from this posting
        {/* The gap count, on the one surface that is visible while the report is closed. Without it
            the whole actionable half sits two clicks down behind a heading that gives no reason to
            take either — and a report nobody opens reports nothing. A count of what is *missing* is
            the direction this component may count in; see the note at the top of the file. */}
        {missing.length > 0 && (
          <span className="coverage-gap-count">{missing.length} not evidenced</span>
        )}
      </summary>

      <div className="keyword-coverage-content">
        {missing.length > 0 && (
          <details className="coverage-group coverage-gap">
            <summary className="coverage-gap-head">
              {missing.length === 1
                ? "1 keyword isn't evidenced by your resume"
                : `${missing.length} keywords aren't evidenced by your resume`}
            </summary>
            <div className="coverage-gap-body">
              <ul className="coverage-list">
                {missing.map((entry) => (
                  <li key={entry.keyword}>
                    <span className="coverage-keyword">{entry.keyword}</span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                If you have any of these, add it to your profile — a skill your profile doesn't list
                can't appear on the tailored resume.
              </p>
              <button
                type="button"
                className="btn-link"
                onClick={() => chrome.runtime.openOptionsPage()}
              >
                Edit your profile
              </button>
            </div>
          </details>
        )}

        <Evidenced label="skills" entries={skills} />
        <Evidenced label="experience" entries={experience} />
      </div>
    </details>
  );
}
