/**
 * The Keyword Coverage block: what the Tailored Resume evidences of the posting's keywords.
 *
 * Deliberately shaped as a **gap list**, not a score. The number this could be reduced to — "you
 * cover 7 of 10" — is the folklore form of "passing the ATS", and a number on screen is a number
 * the candidate will try to raise. There is only one honest way to raise this one, and it is to
 * have the skill; so the surface separates source bullets worth starring from facts truly missing
 * from the Profile, and keeps everything already evidenced collapsed behind a count.
 *
 * The remedy copy is load-bearing: star evidence the Profile already has, or add a missing fact only
 * if the candidate has it. Neither branch tells them to write an unsupported keyword onto a resume.
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

        {profileExperience.length > 0 && (
          <details className="coverage-group coverage-gap">
            <summary className="coverage-gap-head">
              {profileExperience.length === 1
                ? '1 keyword has Profile evidence absent from this resume'
                : `${profileExperience.length} keywords have Profile evidence absent from this resume`}
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
                Star a listed source bullet in your profile to keep that evidence on every tailored
                resume.
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
