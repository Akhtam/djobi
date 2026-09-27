/**
 * The "Log" tab: records an application the candidate made themselves (own resume, LinkedIn Easy
 * Apply) in the same history. Not part of the Application Pipeline — no detected form, no page
 * reads. The extract → review → save state machine is `@djobi/manual-log`'s `useManualLogFlow`;
 * this file supplies the client adapter, the follow-the-tab URL prefill and the UI.
 */
import { isHttpUrl, type Profile } from '@djobi/shared';
import { useManualLogFlow, type ManualLogPorts } from '@djobi/manual-log';
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import { formatAppliedDate } from '../lib/format';

export function LogApplication({
  client,
  profile,
  activeTabUrl,
}: {
  /** The backend seam, handed down by the shell — see `panel/App.tsx`. */
  client: BackendClient;
  profile: Profile;
  /** Prefills the URL field — usually the posting the candidate is looking at while logging it. */
  activeTabUrl: string | null;
}) {
  const [jobUrl, setJobUrl] = useState(activeTabUrl ?? '');
  // Whether the candidate has typed a URL of their own. Until they have, the field follows the tab.
  const [urlEdited, setUrlEdited] = useState(false);
  const [jobDescription, setJobDescription] = useState('');
  // The two fields that become plain `applications` columns, editable before the write since
  // they're what every later list and duplicate check reads.
  const [company, setCompany] = useState('');
  const [roleTitle, setRoleTitle] = useState('');

  // `client` adapted to `ManualLogPorts`. No special 401 handling: it shows as an error like any
  // other (the dashboard redirects to sign-in instead).
  const ports: ManualLogPorts = {
    extractJob: (jobDescription) => client.extractJob(jobDescription),
    findApplicationDuplicates: (jobUrl, signal) => client.findApplicationDuplicates(jobUrl, signal),
    save: async (payload, idempotencyKey) => {
      await client.saveApplication(payload, idempotencyKey);
      return true;
    },
    handleError: () => false,
  };
  const flow = useManualLogFlow(ports);
  const { state } = flow;

  // Required and http(s)-only (`NewApplicationSchema`), and the Duplicate Guard's key — checked
  // here so a bad paste fails in the panel, not as a 400.
  const urlValid = isHttpUrl(jobUrl);

  /**
   * Follows the tracked tab's URL while the field is still the prefill and nothing is extracted, so
   * logging after a navigation files under the right posting. Stops once the candidate types or an
   * extraction is on screen.
   */
  useEffect(() => {
    if (urlEdited || state.kind !== 'form') return;
    setJobUrl(activeTabUrl ?? '');
  }, [activeTabUrl, urlEdited, state.kind]);

  async function handleExtract() {
    if (!jobDescription.trim() || !urlValid) return;
    const jobInfo = await flow.extract(jobUrl, jobDescription);
    if (jobInfo) {
      setCompany(jobInfo.company);
      setRoleTitle(jobInfo.roleTitle);
    }
  }

  function reset() {
    // `jobUrl` isn't cleared here: the effect above re-seeds it from the tracked tab, which is what
    // the next log wants — the candidate is usually moving through postings in the same tab.
    setUrlEdited(false);
    setJobDescription('');
    setCompany('');
    setRoleTitle('');
    flow.backToForm();
  }

  if (state.kind === 'saved') {
    return (
      <div className="state success" role="status">
        <span className="state-icon success">✅</span>
        <p>
          Logged {state.roleTitle} at {state.company}.
        </p>
        <button type="button" className="btn-primary" onClick={reset}>
          Log another
        </button>
      </div>
    );
  }

  if (state.kind === 'extracting') {
    return (
      <div className="state" role="status" aria-live="polite">
        <span className="spinner" />
        <p>Reading the job posting…</p>
      </div>
    );
  }

  // The review step and its two failure variants share a body, so they're rendered together rather
  // than as three near-identical blocks.
  if (state.kind === 'extracted' || state.kind === 'saving' || state.kind === 'save-error') {
    const saving = state.kind === 'saving';
    const duplicate = state.duplicate;

    return (
      <div className="review">
        <div className="review-header">
          <span className="eyebrow">Applied manually</span>
          <h2>Check the details</h2>
        </div>

        {duplicate && (
          <div className="state error" role="alert">
            <span className="state-icon error">📮</span>
            <p>
              {duplicate.count > 1
                ? `You've already logged this job ${duplicate.count} times, most recently on ${formatAppliedDate(duplicate.createdAt)}.`
                : `You already logged this job on ${formatAppliedDate(duplicate.createdAt)}.`}
            </p>
          </div>
        )}

        <label className="question-card">
          <span>Company</span>
          <input value={company} disabled={saving} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="question-card">
          <span>Role</span>
          <input
            value={roleTitle}
            disabled={saving}
            onChange={(e) => setRoleTitle(e.target.value)}
          />
        </label>

        <p className="hint">
          Saved with your profile resume as-is — nothing is tailored, since you applied with your
          own. {state.jobInfo.keywords.length} keyword
          {state.jobInfo.keywords.length === 1 ? '' : 's'} and {state.jobInfo.requirements.length}{' '}
          requirement
          {state.jobInfo.requirements.length === 1 ? '' : 's'} were extracted from the posting.
        </p>

        {state.kind === 'save-error' && (
          <div className="inline-error" role="alert">
            <div className="inline-error-body">
              <p>Something went wrong logging the application.</p>
              <p className="failure-detail">{state.message}</p>
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn-primary"
          onClick={() => void flow.save(profile, company, roleTitle)}
          disabled={saving || !company.trim() || !roleTitle.trim()}
        >
          {saving && <span className="spinner" />}
          {saving ? 'Logging…' : duplicate ? 'Log it anyway' : 'Log application'}
        </button>
        <button
          type="button"
          className="btn-link"
          onClick={() => flow.backToForm()}
          disabled={saving}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="review">
      <div className="review-header">
        <span className="eyebrow">Applied manually</span>
        <h2>Log an application</h2>
      </div>
      <p className="hint">
        For jobs you sent yourself, with your own resume or LinkedIn Easy Apply. Paste the posting
        and djobi files it next to the ones it filled for you.
      </p>

      <label className="question-card">
        <span>Job posting URL</span>
        <input
          value={jobUrl}
          placeholder="https://…"
          onChange={(e) => {
            setUrlEdited(true);
            setJobUrl(e.target.value);
          }}
        />
      </label>
      {jobUrl.trim() !== '' && !urlValid && (
        <p className="failure-detail">That doesn't look like a link. Include the https:// too.</p>
      )}

      <label className="field-label" htmlFor="manual-job-description">
        Manual job description
      </label>
      <textarea
        id="manual-job-description"
        className="page-text-input"
        placeholder="Paste the posting here…"
        value={jobDescription}
        onChange={(e) => setJobDescription(e.target.value)}
      />

      {state.kind === 'extract-error' && (
        <div className="inline-error" role="alert">
          <div className="inline-error-body">
            <p>djobi couldn't read this job posting.</p>
            <p className="failure-detail">{state.message}</p>
          </div>
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        onClick={() => void handleExtract()}
        disabled={!jobDescription.trim() || !urlValid}
      >
        {state.kind === 'extract-error' ? 'Try again' : 'Extract job details'}
      </button>
    </div>
  );
}
