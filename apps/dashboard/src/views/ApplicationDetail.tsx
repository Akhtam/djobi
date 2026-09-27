/**
 * One application: a header card (identity, posting link, stage) and tabs for job info, the posting
 * text (`rawDescription`), the resume sent, drafted answers with per-requirement verdicts
 * (`RequirementList`), and notes. Tabs rather than stacked sections, since they're read one at a
 * time.
 *
 * Nothing here edits the resume or answers; that's the run's review surface in the extension.
 */
import { useState } from 'react';
import type { Application, ApplicationStage, NewNote } from '@djobi/shared';
import { AddNoteForm } from '../components/AddNoteForm';
import { NotesLog } from '../components/NotesLog';
import { PostingLink } from '../components/PostingLink';
import { RequirementList } from '../components/RequirementList';
import { StageSelect } from '../components/StageSelect';
import { evidenceByRequirement } from '../lib/analytics';
import { formatDate } from '../lib/format';
import { KEYWORD_CATEGORY_LABELS } from '../lib/stages';

/** The detail page's four sections, tabbed rather than stacked — see file header. */
const DETAIL_TABS = [
  { key: 'jobinfo', label: 'Job info' },
  { key: 'posting', label: 'Posting' },
  { key: 'materials', label: 'Materials' },
  { key: 'notes', label: 'Notes' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

export function ApplicationDetail({
  application,
  back,
  onStageChange,
  onAddNote,
  onDeleteNote,
  onDeleteApplication,
}: {
  application: Application;
  /**
   * Where the back link returns (the index route as the user left it, filters included). Supplied
   * by `App`, which knows which index route rendered last.
   */
  back: { href: string; label: string };
  onStageChange: (id: string, stage: ApplicationStage) => void;
  onAddNote: (id: string, note: NewNote) => Promise<boolean>;
  onDeleteNote: (id: string, noteId: string) => void;
  /**
   * Deletes the Application (after confirmation); `App` navigates to `back.href` once it resolves.
   * Delete yes, edit no — like notes.
   */
  onDeleteApplication: (id: string) => void;
}) {
  const { jobInfo, tailoredResume, answers } = application;
  // A manually logged application stores the base profile in `tailoredResume` (see `baseResumeOf`),
  // so every heading and hint that says "tailored" has to say something else here.
  const loggedManually = application.source === 'manual';
  const companyName = [application.company, jobInfo.team, jobInfo.location]
    .filter(Boolean)
    .join(' · ');

  const [activeTab, setActiveTab] = useState<DetailTab>('jobinfo');
  // Only one drafted answer open at a time, mirroring the mock's accordion: these are read-once
  // reference material, not a list someone scans with several open side by side.
  const [openAnswer, setOpenAnswer] = useState<number | null>(answers.length > 0 ? 0 : null);
  // Two clicks, never one — see the delete button below.
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Empty for rows saved before verdicts existed; renders as "nothing to say" (see
  // `RequirementList`).
  const evidence = evidenceByRequirement(application);

  return (
    <article className="detail">
      <a className="back-link" href={back.href}>
        ← {back.label}
      </a>

      <header className="detail__header-card">
        <div className="detail__header-title">
          {/* `title` surfaces the untruncated name on hover — the ellipsis clips it visually but
              leaves the full text in the DOM for anything reading it directly. */}
          <h1 title={companyName}>{companyName}</h1>
          <p className="detail__subtitle">{application.roleTitle}</p>
          <p className="detail__meta">
            <PostingLink jobUrl={application.jobUrl} company={application.company} />
            {loggedManually && <span className="source-badge">Applied manually</span>}
          </p>
        </div>
        <div className="detail__header-actions">
          <p className="detail__meta">
            {loggedManually ? 'Logged' : 'Saved'} {formatDate(application.createdAt)}
          </p>
          <StageSelect
            stage={application.stage}
            label="Application stage"
            size="large"
            onChange={(stage) => onStageChange(application.id, stage)}
          />
        </div>
      </header>

      <div className="detail__tabs-row">
        <div className="detail__tabs" role="tablist" aria-label="Application detail sections">
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`detail__tab ${activeTab === tab.key ? 'is-selected' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="detail__danger-zone">
          {deleteArmed ? (
            <p className="note__confirm detail__delete-confirm" role="alert">
              Delete this application permanently? This can’t be undone.
              <button
                type="button"
                className="note__delete note__delete--confirm"
                onClick={() => {
                  setDeleteArmed(false);
                  onDeleteApplication(application.id);
                }}
              >
                Yes, delete
              </button>
              <button type="button" className="note__delete" onClick={() => setDeleteArmed(false)}>
                Keep it
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="detail__delete-trigger"
              aria-label={`Delete application to ${companyName}`}
              onClick={() => setDeleteArmed(true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />
              </svg>
              Delete application
            </button>
          )}
        </div>
      </div>

      {activeTab === 'jobinfo' && (
        <section className="detail__panel">
          <div className="detail__panel-body">
            {jobInfo.seniority ? (
              <dl className="facts">
                <dt>Seniority</dt>
                <dd>{jobInfo.seniority}</dd>
              </dl>
            ) : null}
            {jobInfo.requirements.length > 0 ? (
              <>
                <h3>Requirements</h3>
                <RequirementList requirements={jobInfo.requirements} evidence={evidence} />
              </>
            ) : null}
            {jobInfo.keywords.length > 0 ? (
              <>
                <h3>Keywords</h3>
                <ul className="tags">
                  {jobInfo.keywords.map((keyword) => (
                    <li key={keyword.term} className="tag">
                      {keyword.term}
                      {keyword.category ? (
                        <span className="tag__category">
                          {' '}
                          · {KEYWORD_CATEGORY_LABELS[keyword.category]}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </section>
      )}

      {activeTab === 'posting' && (
        <section className="detail__panel">
          <div className="detail__panel-head">
            <h2>Posting as analyzed</h2>
          </div>
          <div className="detail__panel-body">
            {application.rawDescription ? (
              <>
                <p className="empty-hint">
                  The text the Analysis Step was given{' '}
                  {loggedManually ? 'when you logged this' : 'for this run'} — not the live page,
                  which may have changed or been taken down since.
                </p>
                <pre className="posting-text">{application.rawDescription}</pre>
              </>
            ) : (
              <p className="empty-hint">
                This one was saved before the posting text was kept, so there is no copy of it here.
                The posting link above is all there is — and it may not outlive the role.
              </p>
            )}
          </div>
        </section>
      )}

      {activeTab === 'materials' && (
        <>
          <section className="detail__panel">
            <div className="detail__panel-head">
              <h2>{loggedManually ? 'Resume (untailored)' : 'Tailored resume'}</h2>
            </div>
            <div className="detail__panel-body">
              {loggedManually && (
                <p className="empty-hint">
                  You applied to this one yourself, so this is your profile as it stood when you
                  logged it — nothing was tailored to the posting.
                </p>
              )}
              {tailoredResume.skills.length > 0 ? (
                <ul className="tags">
                  {tailoredResume.skills.map((skill) => (
                    <li key={skill} className="tag">
                      {skill}
                    </li>
                  ))}
                </ul>
              ) : null}
              {tailoredResume.workExperience.map((role) => (
                <div key={`${role.company}-${role.title}`} className="role">
                  <h3>
                    {role.title} · {role.company}
                  </h3>
                  <p className="role__dates">
                    {role.startDate} – {role.endDate ?? 'Present'}
                  </p>
                  <ul className="bullets">
                    {role.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="detail__panel">
            <div className="detail__panel-head">
              <h2>Drafted answers ({answers.length})</h2>
            </div>
            {answers.length === 0 ? (
              <div className="detail__panel-body">
                <p className="empty-hint">
                  {loggedManually
                    ? "You answered this application's questions yourself."
                    : 'This form had no freeform questions.'}
                </p>
              </div>
            ) : (
              <div className="answer-accordion">
                {answers.map((answer, index) => {
                  const isOpen = openAnswer === index;
                  return (
                    <div key={answer.fieldId} className="answer-accordion__item">
                      <button
                        type="button"
                        className="answer-accordion__trigger"
                        aria-expanded={isOpen}
                        onClick={() => setOpenAnswer(isOpen ? null : index)}
                      >
                        <span>{answer.question}</span>
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          className={`answer-accordion__caret ${isOpen ? 'is-open' : ''}`}
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {isOpen ? <p className="answer-accordion__body">{answer.answer}</p> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {activeTab === 'notes' && (
        <section className="detail__panel">
          <div className="detail__panel-head">
            <h2>Notes</h2>
          </div>
          <div className="detail__panel-body">
            <NotesLog
              notes={application.notes}
              onDelete={(noteId) => onDeleteNote(application.id, noteId)}
            />
            <AddNoteForm onAdd={(note) => onAddNote(application.id, note)} />
          </div>
        </section>
      )}
    </article>
  );
}
