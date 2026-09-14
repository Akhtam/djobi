/**
 * Dashboard counterpart to the extension's Log tab: extract a pasted posting, review its identity,
 * then save a manual Application with the candidate's base profile resume.
 *
 * The extract → review → save state machine is `@djobi/manual-log`'s `useManualLogFlow`, shared
 * with the extension's own Log tab (`apps/extension/src/panel/LogApplication.tsx`) — see that
 * package's own doc for what moved there versus what stays here: this file supplies the client
 * adapter, the modal chrome, and how a 401 on extraction routes to sign-in (the dashboard's own
 * policy; the extension's Log tab has none).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isUnauthorized } from '@djobi/http-client';
import { isHttpUrl, type Application, type NewApplicationRequest } from '@djobi/shared';
import { useManualLogFlow, type ManualLogPorts } from '@djobi/manual-log';
import type { DashboardClient } from '../lib/dashboardClient';
import { useRemoteProfile } from '../lib/dashboardSession';
import { formatDate } from '../lib/format';

export function NewApplication({
  client,
  onCreate,
  onSaved,
  onClose,
  onUnauthorized,
}: {
  client: DashboardClient;
  onCreate: (payload: NewApplicationRequest, idempotencyKey: string) => Promise<Application | null>;
  onSaved: () => void;
  onClose: () => void;
  onUnauthorized: () => void;
}) {
  const [jobUrl, setJobUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [company, setCompany] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const modalRef = useRef<HTMLElement>(null);

  // `client`'s own methods, adapted to `ManualLogPorts`'s shape. `onCreate` (`useApplicationStore`'s
  // `createApplication`) already redirects to sign-in on its own 401 — see the store — so `save`
  // only needs to report whether the row landed. `extractJob`/`findApplicationDuplicates` go
  // straight to the client instead, so a 401 there is this flow's own to catch.
  const ports: ManualLogPorts = {
    extractJob: (jobDescription) => client.extractJob(jobDescription),
    findApplicationDuplicates: (jobUrl) => client.findApplicationDuplicates(jobUrl),
    save: async (payload, idempotencyKey) => (await onCreate(payload, idempotencyKey)) !== null,
    handleError: (error, step) => {
      if (step === 'extract' && isUnauthorized(error)) {
        onUnauthorized();
        return true;
      }
      return false;
    },
  };
  const flow = useManualLogFlow(ports);
  const { state } = flow;
  const saving = state.kind === 'saving';

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
      if (!first || !last) return;
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

  // `flow.save` resolving doesn't itself tell this closure the state changed — `state` here is
  // whatever it was when this render's `handleSave` closure was made. Watching `state.kind` is
  // what reacts to the transition `save` actually made, on the render it happens.
  useEffect(() => {
    if (state.kind === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const profileState = useRemoteProfile(client.getProfile, onUnauthorized);

  async function handleExtract(event: FormEvent) {
    event.preventDefault();
    if (!jobDescription.trim() || !isHttpUrl(jobUrl)) return;
    const jobInfo = await flow.extract(jobUrl, jobDescription);
    if (jobInfo) {
      setCompany(jobInfo.company);
      setRoleTitle(jobInfo.roleTitle);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (
      profileState.kind !== 'ready' ||
      (state.kind !== 'extracted' && state.kind !== 'save-error') ||
      !company.trim() ||
      !roleTitle.trim()
    ) {
      return;
    }
    await flow.save(profileState.profile, company, roleTitle);
  }

  const reviewing =
    state.kind === 'extracted' || state.kind === 'saving' || state.kind === 'save-error';
  const extracting = state.kind === 'extracting';

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
            Paste the posting. djobi pulls out the details and files it next to everything the
            extension saved for you.
          </p>
        </div>

        {profileState.kind === 'loading' ? (
          <p className="new-application__state" role="status">
            Loading your profile…
          </p>
        ) : profileState.kind === 'none' ? (
          <div className="new-application__state">
            <strong>You need a profile first</strong>
            <p>
              Save your base resume in the extension’s profile settings, then come back here to log
              this application.
            </p>
          </div>
        ) : profileState.kind === 'unreachable' ? (
          <div className="new-application__state new-application__state--error" role="alert">
            <strong>Couldn’t load your profile</strong>
            <p>{profileState.message}</p>
          </div>
        ) : reviewing ? (
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
                onClick={() => flow.backToForm()}
              >
                Edit posting
              </button>
            </div>

            {state.duplicate ? (
              <div className="new-application__duplicate" role="alert">
                <strong>Already in your dashboard</strong>
                <span>
                  Logged {state.duplicate.count} {state.duplicate.count === 1 ? 'time' : 'times'},
                  most recently {formatDate(state.duplicate.createdAt)}.
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
              <span>{state.jobInfo.requirements.length} requirements</span>
              <span>{state.jobInfo.keywords.length} keywords</span>
              <span>Base profile resume</span>
            </div>

            {state.kind === 'save-error' ? (
              <p className="banner banner--error" role="alert">
                Couldn’t log this application. {state.message}
              </p>
            ) : null}

            <button
              type="submit"
              className="button button--primary new-application__submit"
              disabled={saving || !company.trim() || !roleTitle.trim()}
            >
              {saving
                ? 'Logging application…'
                : state.duplicate
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
                  disabled={extracting}
                  onChange={(event) => setJobUrl(event.target.value)}
                />
                {jobUrl && !isHttpUrl(jobUrl) ? (
                  <small>Needs the full address, starting with http:// or https://.</small>
                ) : null}
              </label>
              <label>
                <span>Job description</span>
                <textarea
                  placeholder="Paste the full job posting here…"
                  value={jobDescription}
                  required
                  disabled={extracting}
                  onChange={(event) => setJobDescription(event.target.value)}
                />
              </label>
            </div>

            {state.kind === 'extract-error' ? (
              <p className="banner banner--error" role="alert">
                Couldn’t read this posting. {state.message}
              </p>
            ) : null}

            <button
              type="submit"
              className="button button--primary new-application__submit"
              disabled={extracting || !jobDescription.trim() || !isHttpUrl(jobUrl)}
            >
              {extracting ? 'Reading job posting…' : 'Extract job details'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
