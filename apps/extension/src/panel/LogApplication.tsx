/**
 * The "Log" tab: records a job the candidate applied to *themselves* — uploading their own resume,
 * or going through something like LinkedIn Easy Apply — so it still lands in the same history the
 * autofill flow writes to.
 *
 * Deliberately not part of the Application Pipeline. This flow needs no detected form and never
 * reads page content; it only follows the active tab's URL as a prefill until the candidate edits it.
 * It therefore doesn't go through `lib/tabStore/` or `PipelineStatus`. Its form and request state
 * are local.
 *
 * The two calls are the ones that already exist: `POST /extract-job` for the job details, then
 * `POST /applications` with `source: 'manual'` and the base profile as the stored resume (see
 * `baseResumeOf`). No tailoring, no answers — the candidate wrote those themselves.
 */
import {
  failureMessage,
  findDuplicate,
  isHttpUrl,
  manualApplicationPayload,
  type JobInfo,
  type Profile,
} from '@djobi/shared';
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/backendClient';
import { formatAppliedDate } from '../lib/format';
import type { DuplicateApplication } from '../lib/run';

/** What the review screen is about: the extracted details, plus whatever the Duplicate Guard found. */
interface Reviewed {
  jobInfo: JobInfo;
  /**
   * What the candidate has already saved for this posting, or `null` — the Duplicate Guard's hit.
   * `null` is the normal case. Warns, never blocks: logging the same posting twice is the
   * candidate's call to make, and so is logging one the guard couldn't check.
   */
  duplicate: DuplicateApplication | null;
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
  | { kind: 'saved'; company: string; roleTitle: string };

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
  const [state, setState] = useState<LogState>({ kind: 'form' });

  // `jobUrl` is required and refused as anything but http(s) by `NewApplicationSchema`, and it's
  // also the key the duplicate guard matches on, so it's a required field here rather than
  // something we invent a placeholder for. `isHttpUrl` is that same rule from `@djobi/shared`,
  // checked before the request so a bad paste fails in the panel and not as a 400.
  const urlValid = isHttpUrl(jobUrl);

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
      //
      // Sharing a `Promise.all` with the extraction is only safe because the guard resolves rather
      // than rejects — see `@djobi/shared`'s `duplicateGuard.ts`. Calling the lookup directly here,
      // as this did, meant a backend hiccup on a *warning* rejected the pair and reported an
      // extraction failure for an extraction that had succeeded, discarding the model call it had
      // just paid for.
      const [jobInfo, duplicate] = await Promise.all([
        client.extractJob(jobDescription),
        findDuplicate(client, jobUrl.trim()),
      ]);
      setCompany(jobInfo.company);
      setRoleTitle(jobInfo.roleTitle);
      setState({ kind: 'extracted', jobInfo, duplicate });
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
      await client.saveApplication(
        manualApplicationPayload(profile, {
          jobUrl,
          jobDescription,
          jobInfo,
          company,
          roleTitle,
        }),
      );
      setState({ kind: 'saved', company: company.trim(), roleTitle: roleTitle.trim() });
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
          onClick={() => void handleSave(state)}
          disabled={saving || !company.trim() || !roleTitle.trim()}
        >
          {saving && <span className="spinner" />}
          {saving ? 'Logging…' : duplicate ? 'Log it anyway' : 'Log application'}
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
