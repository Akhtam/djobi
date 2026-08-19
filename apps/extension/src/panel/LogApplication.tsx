/**
 * The "Log" tab: records a job the candidate applied to *themselves* — uploading their own resume,
 * or going through something like LinkedIn Easy Apply — so it still lands in the same history the
 * autofill flow writes to.
 *
 * Deliberately not part of the Application Pipeline. This flow has no tab-scoped state: it never
 * needs a detected form, never touches the page, and never runs on the active tab, so it doesn't go
 * through `lib/tabStore.ts` (which keys everything by `tabId` and drops it when that tab closes) or
 * `PipelineStatus`. It is a form and two backend calls, and its state is local for that reason.
 *
 * The two calls are the ones that already exist: `POST /extract-job` for the job details, then
 * `POST /applications` with `source: 'manual'` and the base profile as the stored resume (see
 * `baseResumeOf`). No tailoring, no answers — the candidate wrote those themselves.
 */
import { baseResumeOf, type Application, type JobInfo, type Profile } from '@djobi/shared';
import { useEffect, useState } from 'react';
import { httpBackendClient } from '../lib/backendClient';
import { formatAppliedDate } from '../lib/format';

/** What the review screen is about: the extracted details, plus whatever the Duplicate Guard found. */
interface Reviewed {
  jobInfo: JobInfo;
  /**
   * Applications already saved against this job URL, most recent first — the Duplicate Guard's
   * hits. Empty is the normal case. Warns, never blocks: logging the same posting twice is the
   * candidate's call to make.
   */
  duplicates: Application[];
}

/**
 * `extracted` holds the job details for review before anything is written — the extraction is a
 * model call, so the candidate gets to see what it made of the posting (and fix the two fields that
 * become plain columns) before it becomes a row.
 *
 * All three review states carry the same {@link Reviewed} payload, `saving` included: the screen
 * they render is one screen, and dropping the duplicates for the moment the write is in flight only
 * made every reader re-supply them.
 */
type LogState =
  | { kind: 'form' }
  | { kind: 'extracting' }
  | { kind: 'extract-error'; message: string }
  | ({ kind: 'extracted' } & Reviewed)
  | ({ kind: 'saving' } & Reviewed)
  | ({ kind: 'save-error'; message: string } & Reviewed)
  | { kind: 'saved'; application: Application };

/** What went wrong, for the inline error line — a `BackendError` names the path and status. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * `jobUrl` is required and validated as a URL by `NewApplicationSchema`, and it's also the key the
 * duplicate guard matches on, so it's a required field here rather than something we invent a
 * placeholder for. Checked before the request so a bad paste fails in the panel, not as a 400.
 */
function isUsableUrl(value: string): boolean {
  try {
    // http/https only, spelled out: `startsWith('http')` also accepted made-up schemes like
    // `httpx:`, which parse fine and are not something a job posting is ever served over.
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function LogApplication({
  profile,
  activeTabUrl,
}: {
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
  const [state, setState] = useState<LogState>({ kind: 'form' });

  const urlValid = isUsableUrl(jobUrl);

  /**
   * Follows the tracked tab while the field is still the prefill and no extraction exists yet.
   *
   * The panel outlives a navigation, so seeding this once on mount left the field showing whichever
   * posting happened to be open when the panel was opened — log a *different* posting after
   * navigating and the row was filed under the old URL, with the duplicate guard checking the wrong
   * one. Stops following as soon as the candidate types, or once there's an extraction on screen:
   * from then on the URL belongs to what's being reviewed, not to the tab.
   */
  useEffect(() => {
    if (urlEdited || state.kind !== 'form') return;
    setJobUrl(activeTabUrl ?? '');
  }, [activeTabUrl, urlEdited, state.kind]);

  async function handleExtract() {
    if (!jobDescription.trim() || !urlValid) return;

    setState({ kind: 'extracting' });
    try {
      // Both requests go out together: the duplicate check doesn't depend on the extraction, and
      // serializing them would put a database round-trip behind a model call for no reason.
      const [jobInfo, duplicates] = await Promise.all([
        httpBackendClient.extractJob(jobDescription),
        httpBackendClient.findApplicationsByJobUrl(jobUrl.trim()),
      ]);
      setCompany(jobInfo.company);
      setRoleTitle(jobInfo.roleTitle);
      setState({ kind: 'extracted', jobInfo, duplicates });
    } catch (error) {
      setState({ kind: 'extract-error', message: failureMessage(error) });
    }
  }

  async function handleSave(reviewed: Reviewed) {
    if (!company.trim() || !roleTitle.trim() || !urlValid) return;

    const { jobInfo } = reviewed;
    // Spread first: the caller hands us the current review state, so a trailing `...reviewed` would
    // put its old `kind` back and the screen would never leave `extracted`.
    setState({ ...reviewed, kind: 'saving' });
    try {
      const application = await httpBackendClient.saveApplication({
        company: company.trim(),
        roleTitle: roleTitle.trim(),
        jobUrl: jobUrl.trim(),
        // The edited company/role are what the row is keyed by, so they win over the extraction
        // inside the stored snapshot too — otherwise a correction would only half apply.
        jobInfo: { ...jobInfo, company: company.trim(), roleTitle: roleTitle.trim() },
        tailoredResume: baseResumeOf(profile),
        answers: [],
        source: 'manual',
      });
      setState({ kind: 'saved', application });
    } catch (error) {
      setState({ ...reviewed, kind: 'save-error', message: failureMessage(error) });
    }
  }

  function reset() {
    // `jobUrl` isn't cleared here: the effect above re-seeds it from the tracked tab, which is what
    // the next log wants — the candidate is usually moving through postings in the same tab.
    setUrlEdited(false);
    setJobDescription('');
    setCompany('');
    setRoleTitle('');
    setState({ kind: 'form' });
  }

  if (state.kind === 'saved') {
    return (
      <div className="state success">
        <span className="state-icon success">✅</span>
        <p>
          Logged {state.application.roleTitle} at {state.application.company}.
        </p>
        <button type="button" className="btn-primary" onClick={reset}>
          Log another
        </button>
      </div>
    );
  }

  if (state.kind === 'extracting') {
    return (
      <div className="state">
        <span className="spinner" />
        <p>Reading the job posting…</p>
      </div>
    );
  }

  // The review step and its two failure variants share a body, so they're rendered together rather
  // than as three near-identical blocks.
  if (state.kind === 'extracted' || state.kind === 'saving' || state.kind === 'save-error') {
    const saving = state.kind === 'saving';
    const { duplicates } = state;
    const mostRecent = duplicates[0];

    return (
      <div className="review">
        <div className="review-header">
          <span className="eyebrow">Applied manually</span>
          <h2>Check the details</h2>
        </div>

        {mostRecent && (
          <div className="state error">
            <span className="state-icon error">📮</span>
            <p>
              {duplicates.length > 1
                ? `You've already logged this job ${duplicates.length} times, most recently on ${formatAppliedDate(mostRecent.createdAt)}.`
                : `You already logged this job on ${formatAppliedDate(mostRecent.createdAt)}.`}
            </p>
          </div>
        )}

        <label className="question-card">
          <span>Company</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="question-card">
          <span>Role</span>
          <input value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
        </label>

        <p className="hint">
          Saved with your profile resume as-is — nothing is tailored, since you applied with your
          own. {state.jobInfo.keywords.length} keyword
          {state.jobInfo.keywords.length === 1 ? '' : 's'} and {state.jobInfo.requirements.length}{' '}
          requirement
          {state.jobInfo.requirements.length === 1 ? '' : 's'} were extracted from the posting.
        </p>

        {state.kind === 'save-error' && (
          <div className="inline-error">
            <div className="inline-error-body">
              <p>Something went wrong logging the application.</p>
              <p className="failure-detail">{state.message}</p>
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleSave(state)}
          disabled={saving || !company.trim() || !roleTitle.trim()}
        >
          {saving && <span className="spinner" />}
          {saving ? 'Logging…' : mostRecent ? 'Log it anyway' : 'Log application'}
        </button>
        <button
          type="button"
          className="btn-link"
          onClick={() => setState({ kind: 'form' })}
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
        For jobs you applied to yourself — your own resume, or LinkedIn Easy Apply. Paste the
        posting and djobi will extract the details and file it alongside the ones it filled for you.
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
        <p className="failure-detail">That doesn't look like a URL — it needs the https:// too.</p>
      )}

      <textarea
        className="page-text-input"
        placeholder="Paste the posting here…"
        value={jobDescription}
        onChange={(e) => setJobDescription(e.target.value)}
      />

      {state.kind === 'extract-error' && (
        <div className="inline-error">
          <div className="inline-error-body">
            <p>Something went wrong reading this job posting.</p>
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
