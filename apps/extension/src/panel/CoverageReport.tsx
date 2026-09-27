/**
 * The Keyword Coverage block, shaped as a **gap list**, never a score (a number invites keyword
 * stuffing). It separates Profile bullets worth starring from facts missing from the Profile, with
 * covered keywords collapsed behind a count. The copy never suggests adding a keyword the candidate
 * doesn't have.
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
 * @param coverage - The run's Keyword Coverage. Empty renders nothing — "no keywords found" isn't a
 *   clean bill.
 */
export function CoverageReport({ coverage }: { coverage: KeywordCoverage[] }) {
  if (coverage.length === 0) return null;

  const missing = coverage.filter((entry) => entry.verdict === 'missing');
  const profileExperience = coverage.filter((entry) => entry.verdict === 'profile-experience');
  const skills = coverage.filter((entry) => entry.verdict === 'skills');
  const experience = coverage.filter((entry) => entry.verdict === 'experience');
  const gapCount = missing.length + profileExperience.length;

  return (
    <details className="coverage keyword-coverage">
      <summary className="eyebrow keyword-coverage-summary">
        Keywords from this posting
        {/* The gap count, on the one surface that is visible while the report is closed. Without it
            the whole actionable half sits two clicks down behind a heading that gives no reason to
            take either — and a report nobody opens reports nothing. A count of what is *missing* is
            the direction this component may count in; see the note at the top of the file. */}
        {gapCount > 0 && <span className="coverage-gap-count">{gapCount} not evidenced</span>}
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
                If any of these apply to you, add them to your profile. djobi can only put a skill
                on your resume if your profile says you have it.
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

        {profileExperience.length > 0 && (
          <details className="coverage-group coverage-gap">
            <summary className="coverage-gap-head">
              {profileExperience.length === 1
                ? 'Your profile covers 1 keyword this resume left out'
                : `Your profile covers ${profileExperience.length} keywords this resume left out`}
            </summary>
            <div className="coverage-gap-body">
              <ul className="coverage-list">
                {profileExperience.map((entry) => (
                  <li key={entry.keyword}>
                    <span className="coverage-keyword">{entry.keyword}</span>
                    {entry.evidence !== null && (
                      <span className="coverage-evidence">{entry.evidence}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="hint">
                Star one of these bullets in your profile and it stays on every tailored resume.
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
