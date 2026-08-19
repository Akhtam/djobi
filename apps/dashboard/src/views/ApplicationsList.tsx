/**
 * The applications list — the dashboard's home.
 *
 * Cards rather than a table: company and role are what you scan for, and a table spends as much
 * width on the date as on either. Cards also reflow to one column on a narrow window without a
 * horizontal scroller.
 *
 * Filtering is client-side over the already-loaded array. There is no filtered endpoint, this is a
 * personal-scale dataset, and adding query parameters would be inventing backend work.
 */
import { useMemo, useState } from 'react';
import type { Application, ApplicationStage } from '@djobi/shared';
import { countByOption, FilterPills } from '../components/FilterPills';
import { PostingLink } from '../components/PostingLink';
import { StageSelect } from '../components/StageSelect';
import { formatDate } from '../lib/format';
import { IN_PROGRESS_STAGES, STAGES, STAGE_LABELS } from '../lib/stages';
import { applicationPath } from '../lib/useHashRoute';

export function ApplicationsList({
  applications,
  onStageChange,
}: {
  applications: Application[];
  onStageChange: (id: string, stage: ApplicationStage) => void;
}) {
  const [stage, setStage] = useState<ApplicationStage | null>(null);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return applications
      .filter((application) => (stage ? application.stage === stage : true))
      .filter((application) =>
        needle
          ? application.company.toLowerCase().includes(needle) ||
            application.roleTitle.toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [applications, stage, query]);

  const inProgress = applications.filter((a) => IN_PROGRESS_STAGES.includes(a.stage)).length;
  // Built as one string rather than interleaved JSX expressions: a sentence split across text nodes
  // is one the DOM can render correctly but nothing can match as a whole.
  const summary =
    `${applications.length} ${applications.length === 1 ? 'application' : 'applications'}` +
    (inProgress > 0 ? ` · ${inProgress} in progress` : '');

  const counts = countByOption(STAGES, applications, (a) => a.stage);

  return (
    <>
      <div className="list-header">
        <h1>Applications</h1>
        <p className="list-header__summary">{summary}</p>
      </div>

      <div className="list-filters">
        <input
          type="search"
          className="search"
          aria-label="Search company or role"
          placeholder="Search company or role…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <FilterPills
          options={STAGES}
          labels={STAGE_LABELS}
          selected={stage}
          onSelect={setStage}
          groupLabel="Filter by stage"
          counts={counts}
        />
      </div>

      {applications.length === 0 ? (
        <p className="empty-state">
          No applications yet. Fill one in with the extension and hit Save, and it shows up here.
        </p>
      ) : visible.length === 0 ? (
        <p className="empty-state">No applications match that filter.</p>
      ) : (
        <ul className="card-list">
          {visible.map((application) => (
            <li key={application.id} className="card">
              <div className="card__top">
                <span className="card__company">
                  {application.company}
                  {/*
                    No `title` here: `.card__link::after` covers the whole card, so the pointer is
                    never actually over this element and the tooltip could not be reached. The
                    detail page carries the explanation instead.
                  */}
                  {application.source === 'manual' && <span className="source-badge">Manual</span>}
                </span>
                {/*
                  The card is not an <a>. A <select> inside a link is invalid HTML and its clicks
                  navigate; instead one real link on the role title is stretched over the whole card
                  (see `.card__link::after` in App.css) and the stage control is layered above it.
                */}
                <a className="card__link" href={applicationPath(application.id)}>
                  {application.roleTitle}
                </a>
              </div>
              <div className="card__bottom">
                <PostingLink jobUrl={application.jobUrl} company={application.company} stretched />
                <StageSelect
                  stage={application.stage}
                  label={`Stage for ${application.roleTitle} at ${application.company}`}
                  onChange={(next) => onStageChange(application.id, next)}
                />
                <time className="card__date" dateTime={application.createdAt}>
                  {formatDate(application.createdAt)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
