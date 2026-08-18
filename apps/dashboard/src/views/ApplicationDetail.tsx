/**
 * One application: what it is, where it has got to, and what you have learned since.
 *
 * The page is ordered by what *changes*, not by what the schema lists first. Stage and notes are
 * why you come back to an application; the job info, the resume that went out and the drafted
 * answers are reference material, so they sit below in collapsed `<details>`.
 *
 * Nothing here edits the resume or the answers. That belongs to the review surface during a run —
 * a second editor over the same record would need `PATCH /applications/:id` semantics this phase
 * has deliberately not taken on.
 */
import type { Application, ApplicationStage, NewNote } from '@djobi/shared';
import { AddNoteForm } from '../components/AddNoteForm';
import { NotesLog } from '../components/NotesLog';
import { StageSelect } from '../components/StageSelect';
import { formatDate } from '../lib/format';

export function ApplicationDetail({
  application,
  onStageChange,
  onAddNote,
}: {
  application: Application;
  onStageChange: (id: string, stage: ApplicationStage) => void;
  onAddNote: (id: string, note: NewNote) => Promise<boolean>;
}) {
  const { jobInfo, tailoredResume, answers } = application;
  const subtitle = [application.company, jobInfo.team, jobInfo.location]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className="detail">
      <header className="detail__header">
        <a className="back-link" href="#/">
          ← Applications
        </a>
        <h1>{application.roleTitle}</h1>
        <p className="detail__subtitle">{subtitle}</p>
        <p className="detail__meta">Saved {formatDate(application.createdAt)}</p>
        <a className="detail__job-url" href={application.jobUrl} target="_blank" rel="noreferrer">
          {application.jobUrl}
        </a>
      </header>

      <section className="detail__section">
        <h2>Stage</h2>
        <StageSelect
          stage={application.stage}
          label="Application stage"
          size="large"
          onChange={(stage) => onStageChange(application.id, stage)}
        />
      </section>

      <section className="detail__section">
        <h2>Notes</h2>
        <NotesLog notes={application.notes} />
        <AddNoteForm onAdd={(note) => onAddNote(application.id, note)} />
      </section>

      <details className="detail__collapsible">
        <summary>Job info</summary>
        <dl className="facts">
          <dt>Company</dt>
          <dd>{jobInfo.company}</dd>
          {jobInfo.team ? (
            <>
              <dt>Team</dt>
              <dd>{jobInfo.team}</dd>
            </>
          ) : null}
          {jobInfo.seniority ? (
            <>
              <dt>Seniority</dt>
              <dd>{jobInfo.seniority}</dd>
            </>
          ) : null}
          {jobInfo.location ? (
            <>
              <dt>Location</dt>
              <dd>{jobInfo.location}</dd>
            </>
          ) : null}
        </dl>
        {jobInfo.requirements.length > 0 ? (
          <>
            <h3>Requirements</h3>
            <ul className="bullets">
              {jobInfo.requirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </>
        ) : null}
        {jobInfo.keywords.length > 0 ? (
          <>
            <h3>Keywords</h3>
            <ul className="tags">
              {jobInfo.keywords.map((keyword) => (
                <li key={keyword} className="tag">
                  {keyword}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </details>

      <details className="detail__collapsible">
        <summary>Tailored resume</summary>
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
      </details>

      <details className="detail__collapsible">
        <summary>Drafted answers ({answers.length})</summary>
        {answers.length === 0 ? (
          <p className="empty-hint">This form had no freeform questions.</p>
        ) : (
          <ol className="answers">
            {answers.map((answer) => (
              <li key={answer.fieldId} className="answer">
                <p className="answer__question">{answer.question}</p>
                <p className="answer__text">{answer.answer}</p>
              </li>
            ))}
          </ol>
        )}
      </details>
    </article>
  );
}
