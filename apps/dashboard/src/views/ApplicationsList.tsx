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
import { useMemo } from 'react';
import type { Application, ApplicationStage } from '@djobi/shared';
import { countByOption, FilterPills } from '../components/FilterPills';
import { PostingLink } from '../components/PostingLink';
import { StageSelect } from '../components/StageSelect';
import { formatDate } from '../lib/format';
import { IN_PROGRESS_STAGES, STAGE_FILTERS, STAGE_LABELS, stageFilterOf } from '../lib/stages';
import { applicationPath, PAGE_SIZE, type ListFilters } from '../lib/useHashRoute';

export function ApplicationsList({
  applications,
  filters,
  shown,
  onFiltersChange,
  onShowMore,
  onStageChange,
}: {
  applications: Application[];
  /**
   * The filters to render under, owned by the URL rather than by this component — see
   * `useHashRoute`. Held above because this component unmounts whenever an application is opened,
   * which is exactly when the user least wants their search thrown away.
   */
  filters: ListFilters;
  /** How many matching rows to reveal. Held above for the same reason `filters` is. */
  shown: number;
  onFiltersChange: (filters: ListFilters) => void;
  onShowMore: (shown: number) => void;
  onStageChange: (id: string, stage: ApplicationStage) => void;
}) {
  const { query, stage } = filters;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      applications
        // Compared through `stageFilterOf` rather than against the stage itself: the Rejected pill
        // stands for both rejections, so an equality check would hide every ATS-rejected row.
        .filter((application) => (stage ? stageFilterOf(application.stage) === stage : true))
        .filter((application) =>
          needle
            ? application.company.toLowerCase().includes(needle) ||
              application.roleTitle.toLowerCase().includes(needle)
            : true,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
  }, [applications, stage, query]);

  /*
    Load more rather than numbered pages: the rows already on screen stay there, so nothing the
    user was reading moves and there is no scroll position to restore afterwards.

    `shown` comes from the URL and is capped here, not there — a hash can say `show=9999` and the
    slice has to survive it. Capping also means a filter change that shrinks the results can't
    leave the button offering rows that no longer exist.
  */
  const visibleNow = visible.slice(0, Math.min(shown, visible.length));
  const remaining = visible.length - visibleNow.length;

  const inProgress = applications.filter((a) => IN_PROGRESS_STAGES.includes(a.stage)).length;
  // Built as one string rather than interleaved JSX expressions: a sentence split across text nodes
  // is one the DOM can render correctly but nothing can match as a whole.
  const summary =
    `${applications.length} ${applications.length === 1 ? 'application' : 'applications'}` +
    (inProgress > 0 ? ` · ${inProgress} in progress` : '');

  const counts = countByOption(STAGE_FILTERS, applications, (a) => stageFilterOf(a.stage));

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
          onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
        />
        <FilterPills
          options={STAGE_FILTERS}
          labels={STAGE_LABELS}
          selected={stage}
          onSelect={(next) => onFiltersChange({ ...filters, stage: next })}
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
          {visibleNow.map((application) => (
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

      {remaining > 0 && (
        <div className="load-more">
          {/*
            The count is on the button itself, not in separate helper text: it is the answer to
            "is it worth pressing", and a number that lives next to the label cannot drift from it.
          */}
          <button
            type="button"
            className="button load-more__button"
            onClick={() => onShowMore(visibleNow.length + PAGE_SIZE)}
          >
            Load {Math.min(remaining, PAGE_SIZE)} more
          </button>
          {/*
            Announced politely so a screen reader hears the list grow. `aria-live` on a region that
            already exists at first render, rather than one that appears with the first press —
            a live region inserted at the same moment as its content is not reliably announced.
          */}
          <p className="load-more__status" role="status">
            Showing {visibleNow.length} of {visible.length}
          </p>
        </div>
      )}
    </>
  );
}
