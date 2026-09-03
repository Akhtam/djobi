/**
 * Dashboard counterpart to the extension's Log tab: extract a pasted posting, review its identity,
 * then save a manual Application with the candidate's base profile resume.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HttpError } from '@djobi/http-client';
import {
  failureMessage,
  findDuplicate,
  manualApplicationPayload,
  type Application,
  type DuplicateApplication,
  type JobInfo,
  type NewApplicationRequest,
  type Profile,
} from '@djobi/shared';
import type { DashboardClient } from '../lib/dashboardClient';
import { formatDate } from '../lib/format';

interface Review {
  jobInfo: JobInfo;
  duplicate: DuplicateApplication | null;
}

type ProfileState =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: Profile }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

function isUsableUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.kind === 'http' && error.status === 401;
}

export function NewApplication({
  client,
  onCreate,
  onSaved,
  onClose,
  onUnauthorized,
}: {
  client: DashboardClient;
  onCreate: (payload: NewApplicationRequest) => Promise<Application | null>;
  onSaved: () => void;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [profileState, setProfileState] = useState<ProfileState>({ kind: 'loading' });
  const [jobUrl, setJobUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [company, setCompany] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose();
      if (event.key !== 'Tab') return;
      const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, saving]);

  useEffect(() => {
    let current = true;
    client.getProfile().then(
      (profile) => {
        if (current) setProfileState(profile ? { kind: 'ready', profile } : { kind: 'none' });
      },
      (profileError: unknown) => {
        if (!current) return;
        if (isUnauthorized(profileError)) onUnauthorized();
        else setProfileState({ kind: 'error', message: failureMessage(profileError) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, onUnauthorized]);

  async function handleExtract(event: FormEvent) {
    event.preventDefault();
    if (!jobDescription.trim() || !isUsableUrl(jobUrl)) return;
    setExtracting(true);
    setError(null);
    try {
      // Sharing a `Promise.all` with the extraction is only safe because `findDuplicate` resolves
      // rather than rejects (see `@djobi/shared`'s `duplicateGuard.ts`) — an inline `.catch` here
      // used to re-throw on a 401, which rejected the pair and discarded a successful, already-paid
      // extraction over a failure in an advisory check that was never supposed to block anything.
      const [jobInfo, duplicate] = await Promise.all([
        client.extractJob(jobDescription.trim()),
        findDuplicate(client, jobUrl.trim()),
      ]);
      setCompany(jobInfo.company);
      setRoleTitle(jobInfo.roleTitle);
      setReview({ jobInfo, duplicate });
    } catch (extractError) {
      if (isUnauthorized(extractError)) onUnauthorized();
      else setError(failureMessage(extractError));
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (profileState.kind !== 'ready' || !review || !company.trim() || !roleTitle.trim()) {
      return;
    }

    setSaving(true);
    const payload: NewApplicationRequest = manualApplicationPayload(profileState.profile, {
      jobUrl,
      jobDescription,
      jobInfo: review.jobInfo,
      company,
      roleTitle,
    });
    const created = await onCreate(payload);
    setSaving(false);
    if (created) onSaved();
  }

  return (
    <div
      className="new-application-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="new-application"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-application-title"
      >
        <button
          type="button"
          className="new-application__close"
          aria-label="Close log application"
          disabled={saving}
          autoFocus
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <div className="new-application__heading">
          <p className="new-application__eyebrow">Applied manually</p>
          <h1 id="new-application-title">Log an application</h1>
          <p>
            Paste the posting and djobi will extract its details, then file it alongside
            applications logged from the extension.
          </p>
        </div>

        {profileState.kind === 'loading' ? (
          <p className="new-application__state" role="status">
            Loading your profile…
          </p>
        ) : profileState.kind === 'none' ? (
          <div className="new-application__state">
            <strong>A profile is required first</strong>
            <p>
              Save your base resume in the extension’s Profile settings, then return here to log
              this application.
            </p>
          </div>
        ) : profileState.kind === 'error' ? (
          <div className="new-application__state new-application__state--error" role="alert">
            <strong>Couldn’t load your profile</strong>
            <p>{profileState.message}</p>
          </div>
        ) : review ? (
          <form className="new-application__panel" onSubmit={(event) => void handleSave(event)}>
            <div className="new-application__panel-head">
              <div>
                <span>Review</span>
                <h2>Check the extracted details</h2>
              </div>
              <button
                type="button"
                className="button new-application__back-button"
                disabled={saving}
                onClick={() => setReview(null)}
              >
                Edit posting
              </button>
            </div>

            {review.duplicate ? (
              <div className="new-application__duplicate" role="alert">
                <strong>Already in your dashboard</strong>
                <span>
                  Logged {review.duplicate.count} {review.duplicate.count === 1 ? 'time' : 'times'},
                  most recently {formatDate(review.duplicate.createdAt)}.
                </span>
              </div>
            ) : null}

            <div className="new-application__fields new-application__fields--review">
              <label>
                <span>Company</span>
                <input
                  className="search"
                  value={company}
                  disabled={saving}
                  required
                  onChange={(event) => setCompany(event.target.value)}
                />
              </label>
              <label>
                <span>Role</span>
                <input
                  className="search"
                  value={roleTitle}
                  disabled={saving}
                  required
                  onChange={(event) => setRoleTitle(event.target.value)}
                />
              </label>
            </div>

            <div className="new-application__extraction-summary">
              <span>{review.jobInfo.requirements.length} requirements</span>
              <span>{review.jobInfo.keywords.length} keywords</span>
              <span>Base profile resume</span>
            </div>

            <button
              type="submit"
              className="button button--primary new-application__submit"
              disabled={saving || !company.trim() || !roleTitle.trim()}
            >
              {saving
                ? 'Logging application…'
                : review.duplicate
                  ? 'Log it anyway'
                  : 'Log application'}
            </button>
          </form>
        ) : (
          <form className="new-application__panel" onSubmit={(event) => void handleExtract(event)}>
            <div className="new-application__fields">
              <label>
                <span>Job posting URL</span>
                <input
                  className="search"
                  type="url"
                  placeholder="https://company.com/jobs/role"
                  value={jobUrl}
                  required
                  onChange={(event) => setJobUrl(event.target.value)}
                />
                {jobUrl && !isUsableUrl(jobUrl) ? (
                  <small>Enter a complete http:// or https:// URL.</small>
                ) : null}
              </label>
              <label>
                <span>Job description</span>
                <textarea
                  placeholder="Paste the full job posting here…"
                  value={jobDescription}
                  required
                  onChange={(event) => setJobDescription(event.target.value)}
                />
              </label>
            </div>

            {error ? (
              <p className="banner banner--error" role="alert">
                Couldn’t read this posting. {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="button button--primary new-application__submit"
              disabled={extracting || !jobDescription.trim() || !isUsableUrl(jobUrl)}
            >
              {extracting ? 'Reading job posting…' : 'Extract job details'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
