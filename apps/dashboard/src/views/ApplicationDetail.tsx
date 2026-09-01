/**
 * One application: what it is, where it has got to, and what you have learned since.
 *
 * The header card carries identity and the two actions that change often (posting link, stage).
 * Everything else — job info, the resume that went out, drafted answers, and notes — sits behind a
 * tab bar rather than stacked `<details>`: those sections are read one at a time, and a tab keeps
 * the reader's place instead of asking them to scroll past whichever ones they didn't open.
 *
 * Nothing here edits the resume or the answers. That belongs to the review surface during a run —
 * a second editor over the same record would need `PATCH /applications/:id` semantics this phase
 * has deliberately not taken on.
 */
import { useState } from 'react';
import type { Application, ApplicationStage, NewNote } from '@djobi/shared';
import { AddNoteForm } from '../components/AddNoteForm';
import { NotesLog } from '../components/NotesLog';
import { PostingLink } from '../components/PostingLink';
import { StageSelect } from '../components/StageSelect';
import { formatDate } from '../lib/format';
import { KEYWORD_CATEGORY_LABELS } from '../lib/stages';

/** The detail page's three sections, tabbed rather than stacked — see file header. */
const DETAIL_TABS = [
  { key: 'jobinfo', label: 'Job info' },
  { key: 'materials', label: 'Materials' },
  { key: 'notes', label: 'Notes' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

export function ApplicationDetail({
  application,
  back,
  onStageChange,
  onAddNote,
}: {
  application: Application;
  /**
   * Where the back link returns to, and what it calls that place — the index route *as the user
   * left it*, filters included, not a bare `#/`. Passed in because this page cannot know it: both
   * index routes (Applications, Analytics) can be one history entry back, each with its own
   * filters, and only `App` knows which one rendered last. See `App`.
   */
  back: { href: string; label: string };
  onStageChange: (id: string, stage: ApplicationStage) => void;
  onAddNote: (id: string, note: NewNote) => Promise<boolean>;
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

  const requirementGroups = [
    {
      kind: 'required' as const,
      requirements: jobInfo.requirements.filter((requirement) => requirement.kind !== 'preferred'),
    },
    {
      kind: 'preferred' as const,
      requirements: jobInfo.requirements.filter((requirement) => requirement.kind === 'preferred'),
    },
  ];

  return (
    <article className="detail">
      <a className="back-link" href={back.href}>
        ← {back.label}
      </a>

      <header className="detail__header-card">
        <div>
          <h1>{companyName}</h1>
          <p className="detail__subtitle">{application.roleTitle}</p>
          <p className="detail__meta">
            {loggedManually ? 'Logged' : 'Saved'} {formatDate(application.createdAt)}
            {loggedManually && <span className="source-badge">Applied manually</span>}
          </p>
        </div>
        <div className="detail__header-actions">
          <PostingLink jobUrl={application.jobUrl} company={application.company} />
          <StageSelect
            stage={application.stage}
            label="Application stage"
            size="large"
            onChange={(stage) => onStageChange(application.id, stage)}
          />
        </div>
      </header>

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
                <div className="requirement-groups">
                  {requirementGroups.map(({ kind, requirements }) =>
                    requirements.length > 0 ? (
                      <section
                        key={kind}
                        className={`requirement-group requirement-group--${kind}`}
                      >
                        <h4
                          className={`requirement-group__title requirement-kind requirement-kind--${kind}`}
                        >
                          {kind}
                        </h4>
                        <ul className="bullets requirement-group__items">
                          {requirements.map((requirement) => (
                            <li key={requirement.text}>
                              {requirement.text}
                              {requirement.yearsOfExperience !== null ? (
                                <span className="requirement-years">
                                  {' '}
                                  ({requirement.yearsOfExperience}+ yrs)
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null,
                  )}
                </div>
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
            <NotesLog notes={application.notes} />
            <AddNoteForm onAdd={(note) => onAddNote(application.id, note)} />
          </div>
        </section>
      )}
    </article>
  );
}
