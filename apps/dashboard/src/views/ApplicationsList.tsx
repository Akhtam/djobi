/**
 * The applications list — the dashboard's home.
 *
 * A scan-first table on desktop, restyled as stacked rows on narrow screens from the same semantic
 * markup. Company and role lead; source, stage, date, and posting remain aligned and directly usable.
 *
 * Filtering is client-side over the already-loaded array. There is no filtered endpoint, this is a
 * personal-scale dataset, and adding query parameters would be inventing backend work.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Application, ApplicationStage, NewApplicationRequest } from '@djobi/shared';
import { countByOption, FilterPills } from '../components/FilterPills';
import { PostingLink } from '../components/PostingLink';
import { StageSelect } from '../components/StageSelect';
import { stageFilterIcon } from '../components/StageFilterIcon';
import { formatDate } from '../lib/format';
import type { DashboardClient } from '../lib/dashboardClient';
import {
  IN_PROGRESS_STAGES,
  REJECTION_FILTER_LABELS,
  REJECTION_FILTERS,
  STAGE_FILTERS,
  STAGE_LABELS,
  stageFilterOf,
} from '../lib/stages';
import { applicationPath, PAGE_SIZE, type ListFilters } from '../lib/useHashRoute';
import { NewApplication } from './NewApplication';

function sourceLabel(application: Application): { label: string; kind: string } {
  if (application.source === 'manual') return { label: 'Manual', kind: 'manual' };
  try {
    const hostname = new URL(application.jobUrl).hostname.toLowerCase();
    if (hostname.includes('greenhouse.io')) return { label: 'Greenhouse', kind: 'greenhouse' };
    if (hostname.includes('lever.co')) return { label: 'Lever', kind: 'lever' };
    if (hostname.includes('ashbyhq.com')) return { label: 'Ashby', kind: 'ashby' };
    if (hostname.includes('myworkdayjobs.com') || hostname.includes('workday.com')) {
      return { label: 'Workday', kind: 'workday' };
    }
    return { label: hostname.replace(/^www\./, ''), kind: 'other' };
  } catch {
    return { label: 'Web', kind: 'other' };
  }
}

export function ApplicationsList({
  applications,
  client,
  filters,
  shown,
  onFiltersChange,
  onSortChange,
  onShowMore,
  onStageChange,
  onCreateApplication,
  onUnauthorized,
}: {
  applications: Application[];
  client: DashboardClient;
  /**
   * The filters to render under, owned by the URL rather than by this component — see
   * `useHashRoute`. Held above because this component unmounts whenever an application is opened,
   * which is exactly when the user least wants their search thrown away.
   */
  filters: ListFilters;
  /** How many matching rows to reveal. Held above for the same reason `filters` is. */
  shown: number;
  onFiltersChange: (filters: ListFilters) => void;
  /**
   * Flips the applied-date order, separately from {@link onFiltersChange}.
   *
   * A sort is not a filter: `query`/`stage`/`rejection` each narrow *which* rows qualify, which is
   * why changing one collapses `shown` back to the first batch (see `App`'s own comment on that
   * call) — the revealed rows belonged to a population that no longer exists. Reordering the same
   * population doesn't do that, and routing it through `onFiltersChange` used to collapse a
   * `Load more`d list back to twenty rows on nothing but a re-sort.
   */
  onSortChange: (sort: 'oldest' | undefined) => void;
  onShowMore: (shown: number) => void;
  onStageChange: (id: string, stage: ApplicationStage) => void;
  onCreateApplication: (
    payload: NewApplicationRequest,
    idempotencyKey: string,
  ) => Promise<Application | null>;
  onUnauthorized: () => void;
}) {
  const { query, stage, rejection, sort } = filters;
  const [loggingApplication, setLoggingApplication] = useState(false);
  const logButtonRef = useRef<HTMLButtonElement>(null);

  const closeLogApplication = useCallback(() => {
    setLoggingApplication(false);
    requestAnimationFrame(() => logButtonRef.current?.focus());
  }, []);

  const searchMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return applications.filter((application) =>
      needle
        ? application.company.toLowerCase().includes(needle) ||
          application.roleTitle.toLowerCase().includes(needle)
        : true,
    );
  }, [applications, query]);

  const visible = useMemo(
    () =>
      searchMatches
        .filter((application) => {
          if (!stage) return true;
          if (stage === 'rejected' && rejection) return application.stage === rejection;
          return stageFilterOf(application.stage) === stage;
        })
        .sort((a, b) =>
          sort === 'oldest'
            ? a.createdAt.localeCompare(b.createdAt)
            : b.createdAt.localeCompare(a.createdAt),
        ),
    [rejection, searchMatches, sort, stage],
  );

  /*
    Load more rather than numbered pages: the rows already on screen stay there, so nothing the
    user was reading moves and there is no scroll position to restore afterwards.

    `shown` comes from the URL and is capped here, not there — a hash can say `show=9999` and the
    slice has to survive it. Capping also means a filter change that shrinks the results can't
    leave the button offering rows that no longer exist.
  */
  const visibleNow = visible.slice(0, Math.min(shown, visible.length));
  const remaining = visible.length - visibleNow.length;

  const inProgress = useMemo(
    () => applications.filter((a) => IN_PROGRESS_STAGES.includes(a.stage)).length,
    [applications],
  );
  // Built as one string rather than interleaved JSX expressions: a sentence split across text nodes
  // is one the DOM can render correctly but nothing can match as a whole.
  const summary =
    `${applications.length} ${applications.length === 1 ? 'application' : 'applications'}` +
    (inProgress > 0 ? ` · ${inProgress} in progress` : '');

  // Memoized on the search results alone, so changing the stage filter, sort or page size doesn't
  // recount them.
  const { counts, rejectionCounts } = useMemo(() => {
    const rejectionCounts = { rejected_ats: 0, rejected: 0 };
    for (const a of searchMatches) {
      if (a.stage === 'rejected_ats' || a.stage === 'rejected') rejectionCounts[a.stage] += 1;
    }
    return {
      counts: countByOption(STAGE_FILTERS, searchMatches, (a) => stageFilterOf(a.stage)),
      rejectionCounts,
    };
  }, [searchMatches]);
  const rejectedCount = rejectionCounts.rejected_ats + rejectionCounts.rejected;

  return (
    <>
      <div className="list-header">
        <div>
          <h1>Applications</h1>
          <p className="list-header__summary">{summary}</p>
        </div>
        <button
          ref={logButtonRef}
          type="button"
          className="log-application-button"
          onClick={() => setLoggingApplication(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Log application
        </button>
      </div>

      <div className="list-filters">
        <label className="list-search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
          <input
            type="search"
            aria-label="Search company or role"
            placeholder="Search company or role…"
            value={query}
            onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          />
        </label>
        <div className="list-stage-filter-stack">
          <div className="list-stage-filters segmented-filter">
            <FilterPills
              options={STAGE_FILTERS}
              labels={STAGE_LABELS}
              selected={stage}
              onSelect={(next) =>
                onFiltersChange({
                  ...filters,
                  stage: next,
                  rejection: next === 'rejected' ? rejection : undefined,
                })
              }
              groupLabel="Filter by stage"
              counts={counts}
              allCount={searchMatches.length}
              renderIcon={stageFilterIcon}
            />
          </div>
          {stage === 'rejected' ? (
            <div className="list-rejection-filters">
              <span className="list-rejection-filters__label">Rejected by</span>
              <FilterPills
                options={REJECTION_FILTERS}
                labels={REJECTION_FILTER_LABELS}
                selected={rejection ?? null}
                onSelect={(next) => onFiltersChange({ ...filters, rejection: next })}
                allLabel="All rejected"
                allCount={rejectedCount}
                groupLabel="Filter rejected applications"
                counts={rejectionCounts}
              />
            </div>
          ) : null}
        </div>
      </div>

      {applications.length === 0 ? (
        <p className="empty-state">
          No applications yet. Fill one in with the extension and hit Save, and it shows up here.
        </p>
      ) : visible.length === 0 ? (
        <p className="empty-state">No applications match that filter.</p>
      ) : (
        <div className="application-table-wrap">
          <table className="application-table">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Posting</th>
                <th scope="col">Role</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
                <th
                  scope="col"
                  className="application-table__date-heading"
                  aria-sort={sort === 'oldest' ? 'ascending' : 'descending'}
                >
                  <button
                    type="button"
                    aria-label={`Sort by applied date, ${sort === 'oldest' ? 'newest first' : 'oldest first'}`}
                    onClick={() => onSortChange(sort === 'oldest' ? undefined : 'oldest')}
                  >
                    Applied
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d={sort === 'oldest' ? 'm4 6 4-4 4 4M8 2v12' : 'M8 2v12m-4-4 4 4 4-4'}
                      />
                    </svg>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleNow.map((application) => {
                const source = sourceLabel(application);
                return (
                  <tr
                    key={application.id}
                    data-application-row
                    onClick={(event) => {
                      const target = event.target as Element;
                      if (target.closest('a, [data-row-navigation-ignore]')) return;
                      window.location.hash = applicationPath(application.id);
                    }}
                  >
                    <td data-label="Company" className="application-table__company">
                      {application.company}
                    </td>
                    <td
                      data-label="Posting"
                      className="application-table__posting"
                      data-row-navigation-ignore
                    >
                      <PostingLink jobUrl={application.jobUrl} company={application.company} />
                    </td>
                    <td data-label="Role" className="application-table__role">
                      <a href={applicationPath(application.id)}>{application.roleTitle}</a>
                    </td>
                    <td data-label="Source">
                      <span className={`application-source application-source--${source.kind}`}>
                        {source.label}
                      </span>
                    </td>
                    <td data-label="Status" data-row-navigation-ignore>
                      <StageSelect
                        stage={application.stage}
                        label={`Stage for ${application.roleTitle} at ${application.company}`}
                        onChange={(next) => onStageChange(application.id, next)}
                      />
                    </td>
                    <td data-label="Applied" className="application-table__date">
                      <time dateTime={application.createdAt}>
                        {formatDate(application.createdAt)}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {remaining > 0 && (
        <div className="load-more">
          <button
            type="button"
            className="button load-more__button"
            onClick={() => onShowMore(visibleNow.length + PAGE_SIZE)}
          >
            Load more
          </button>
          <p className="load-more__status" role="status">
            Showing {visibleNow.length} of {visible.length} applications
          </p>
        </div>
      )}

      {loggingApplication ? (
        <NewApplication
          client={client}
          onCreate={onCreateApplication}
          onSaved={closeLogApplication}
          onClose={closeLogApplication}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
