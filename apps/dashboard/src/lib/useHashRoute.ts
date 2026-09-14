/**
 * Hash-based routing for the dashboard's two views.
 *
 * Hash rather than the History API because this app is served as a static SPA with no server
 * rewrite rule: a real path deep link would 404 before React ever ran. Hand-rolled rather than
 * `react-router` because two routes do not pay for the dependency — the extension pulls in only
 * React, and this app should look like it belongs to the same repo.
 *
 * The list's filters and how much of it has been revealed live in the URL rather than in
 * `ApplicationsList`'s state. Component state dies with the component, and the list unmounts every
 * time an application is opened — so the search box, the stage pill and everything the user had
 * loaded reset on the way back. Keeping them here means back/forward and a copied link reproduce
 * the same view, and nothing depends on which components happen to stay mounted.
 *
 * With one deliberate exception: `?show=` is dropped when the document loads — see
 * {@link useHashRoute}. A filter is an intent the user expressed; a revealed row count is just how
 * far they got in a session.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApplicationStageSchema } from '@djobi/shared';
import { DEFAULT_RANGE, RANGES, type Range } from './analytics';
import { REJECTION_FILTERS, stageFilterOf, type RejectionFilter, type StageFilter } from './stages';

/**
 * How many rows the list reveals at a time — the first render's worth, and one press of Load more.
 *
 * Lives here rather than in the view because it is the unit the URL counts in: `?show=` is a row
 * count, and its default is this.
 */
export const PAGE_SIZE = 20;

/** What the list is narrowed to. Fields are "no filter" when empty/null. */
export interface ListFilters {
  /** Free text matched against company and role. Trimmed at the point of matching, not here. */
  query: string;
  /**
   * A {@link StageFilter}, not an `ApplicationStage`: the two rejections share one pill, so there
   * is no filter value that selects only `rejected_ats`.
   */
  stage: StageFilter | null;
  /** An exact rejection outcome, used only while the combined Rejected stage is selected. */
  rejection?: RejectionFilter | null | undefined;
  /** Applied-date order. Newest-first is the default and is omitted from the URL. */
  sort?: 'oldest' | undefined;
}

/**
 * The list of applications, narrowed by {@link ListFilters} and cut off after `shown` rows.
 *
 * `shown` is a row count rather than a page number because the list loads more instead of paging:
 * pressing Load more keeps what is already on screen. It sits beside the filters rather than
 * inside them because the two change under different rules — a filter change collapses the list
 * back to one batch (see `App`), revealing more leaves the filters alone. Folding it into
 * `ListFilters` invites `{ ...filters, query }` to carry a stale count into a result set that no
 * longer has that many rows.
 */
export type ListRoute = { name: 'list'; filters: ListFilters; shown: number };
/** One application's detail page. */
export type DetailRoute = { name: 'detail'; id: string };
/**
 * The Analytics view: the same `?stage=` pill as the list, filtered instead by `?range=` — a
 * different question ("what have I been applying to lately") over the same rows, so it borrows the
 * list's stage vocabulary rather than inventing its own.
 */
export type AnalyticsRoute = { name: 'analytics'; range: Range; stage: StageFilter | null };
/**
 * The sign-in view. `from` is the full hash (including its own `?query`) the app redirected from,
 * for `App` to send the user back to after a successful sign-in — a bookmarked detail page or a
 * filtered list, not always `#/`. `null` when there was nothing to return to: navigating here
 * directly, or a fresh document that redirected before any other route had rendered.
 */
export type LoginRoute = { name: 'login'; from: string | null };
/** The sign-up view. No `from`: a fresh account has nowhere to return to but the list. */
export type SignUpRoute = { name: 'signup' };
/** The account-profile editor — the same Profile the extension edits, reachable from the header. */
export type ProfileRoute = { name: 'profile' };
export type Route =
  ListRoute | DetailRoute | AnalyticsRoute | LoginRoute | SignUpRoute | ProfileRoute;

/** A valid {@link Range}, or `null` for anything else — the same shape `stageFilterOf` answers in. */
function rangeOf(value: string | null): Range | null {
  return (RANGES as readonly string[]).includes(value ?? '') ? (value as Range) : null;
}

/**
 * The `?stage=` pill, shared by the list and Analytics routes: parsed through the schema rather
 * than cast, so `?stage=banana` means "no filter" rather than a stage nothing can render, and a
 * valid stage with no pill of its own (`?stage=rejected_ats`) normalises onto the pill it shares
 * rather than dropping the filter.
 */
function stageFilterFrom(params: URLSearchParams): StageFilter | null {
  const stage = ApplicationStageSchema.safeParse(params.get('stage'));
  return stage.success ? stageFilterOf(stage.data) : null;
}

function rejectionFilterFrom(params: URLSearchParams): RejectionFilter | null {
  const rejection = params.get('rejection');
  return REJECTION_FILTERS.includes(rejection as RejectionFilter)
    ? (rejection as RejectionFilter)
    : null;
}

/**
 * Parses a location hash into a {@link Route}.
 *
 * Anything unrecognised — including the empty hash a first visit arrives with — is the list. A
 * dashboard that renders "not found" because a URL has no fragment would be a worse answer than
 * showing the user their applications.
 *
 * A hash is user-editable text, so `stage` and `range` are each parsed through a closed set rather
 * than cast: `?stage=banana` has to mean "no stage filter" and `?range=lots` has to mean the
 * default range, neither a value nothing can render. Same reasoning for the unrecognised-hash
 * fallback, one level down.
 *
 * `?show=` is floored at one batch, but *not* capped: this function parses a URL and knows nothing
 * about how many applications exist. The list caps it against the real count at render time.
 */
export function parseHash(hash: string): Route {
  const [path = '', search = ''] = hash.split('?');

  const id = /^#\/applications\/([^/?#]+)$/.exec(path)?.[1];
  if (id) return { name: 'detail', id: decodeURIComponent(id) };

  const params = new URLSearchParams(search);

  if (path === '#/login') {
    return { name: 'login', from: params.get('from') };
  }

  if (path === '#/signup') {
    return { name: 'signup' };
  }

  if (path === '#/profile') {
    return { name: 'profile' };
  }

  if (path === '#/analytics') {
    return {
      name: 'analytics',
      range: rangeOf(params.get('range')) ?? DEFAULT_RANGE,
      stage: stageFilterFrom(params),
    };
  }

  const shown = Number(params.get('show'));
  const stage = stageFilterFrom(params);
  const rejection = stage === 'rejected' ? rejectionFilterFrom(params) : null;
  return {
    name: 'list',
    filters: {
      query: params.get('q') ?? '',
      stage,
      ...(rejection ? { rejection } : {}),
      ...(params.get('sort') === 'oldest' ? { sort: 'oldest' as const } : {}),
    },
    shown: Number.isInteger(shown) && shown > PAGE_SIZE ? shown : PAGE_SIZE,
  };
}

/** The path for one application's detail view — the single place this URL shape is written. */
export function applicationPath(id: string): string {
  return `#/applications/${encodeURIComponent(id)}`;
}

/**
 * The path for the list under `filters`, revealing `shown` rows — the inverse of {@link parseHash}.
 *
 * An empty filter is omitted rather than written as `q=`, so the unfiltered list is `#/` and not
 * `#/?q=&stage=&show=20`. The two would render identically, but only one of them is a URL worth
 * keeping — and `show=20` in particular would otherwise appear before anything had been loaded.
 */
export function listPath(filters: ListFilters, shown: number = PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.stage) params.set('stage', filters.stage);
  if (filters.stage === 'rejected' && filters.rejection) {
    params.set('rejection', filters.rejection);
  }
  if (filters.sort === 'oldest') params.set('sort', 'oldest');
  if (shown > PAGE_SIZE) params.set('show', String(shown));
  const search = params.toString();
  return search ? `#/?${search}` : '#/';
}

/**
 * The path for the Analytics view under `range` and `stage` — the inverse of {@link parseHash}'s
 * `#/analytics` branch. `range` is omitted at its default for the same reason `listPath` omits an
 * empty filter: `#/analytics` and `#/analytics?range=14d` render identically, and only the shorter
 * one is a URL worth keeping.
 */
export function analyticsPath(range: Range, stage: StageFilter | null): string {
  const params = new URLSearchParams();
  if (range !== DEFAULT_RANGE) params.set('range', range);
  if (stage) params.set('stage', stage);
  const search = params.toString();
  return search ? `#/analytics?${search}` : '#/analytics';
}

/**
 * The path to the login view — the inverse of {@link parseHash}'s `#/login` branch. `from` is
 * carried as-is (typically another `pathXxx` helper's own output, `#` and all) rather than split
 * into parts, since this route only ever needs to hand it back to `App` unchanged.
 */
export function loginPath(from?: string | null): string {
  if (!from) return '#/login';
  const params = new URLSearchParams({ from });
  return `#/login?${params.toString()}`;
}

/** The path to the sign-up view. */
export function signUpPath(): string {
  return '#/signup';
}

/** The path to the account-profile editor. */
export function profilePath(): string {
  return '#/profile';
}

export interface HashRoute {
  route: Route;
  /**
   * Rewrites the hash **in place**, without a history entry.
   *
   * This is how a filter change and a Load more are written: a push per keystroke would bury the
   * previous page under a stack of near-identical entries and make Back useless. Opening an
   * application is a plain `<a href>` — a real push — so Back from a detail page returns to the
   * list hash exactly as this last replaced it, filters and revealed rows and all.
   */
  replaceRoute(hash: string): void;
}

/**
 * The current route, kept in sync with the browser's back/forward buttons.
 *
 * A fresh document — a reload, a bookmark, a pasted link — starts the list at its first batch, so
 * `?show=` is stripped on mount. It survives everything *within* a session, which is what it is
 * for: opening an application and coming back does not reload the document, and Back is a hash
 * change, so a user never loses their place by navigating. What it does not do is make a cold load
 * render hundreds of rows before the user has asked for any of them.
 *
 * Stripping it here rather than in `parseHash` is what preserves that split: the parser has to keep
 * reading `?show=` for it to survive a Back, so "which document load is this" can only be answered
 * once, at mount.
 */
export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
    }

    const initial = parseHash(window.location.hash);
    if (initial.name === 'list' && initial.shown > PAGE_SIZE) {
      // `replaceState`, so the count the document opened with is not left one Back away.
      window.history.replaceState(window.history.state, '', listPath(initial.filters));
    }

    // Re-read on mount as well as on change: the hash can be set between the initial `useState`
    // and this effect running, and a route read once at render time would miss it.
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const replaceRoute = useCallback((hash: string) => {
    // `replaceState` deliberately does not fire `hashchange`, so the listener above will not see
    // this write and the new route has to be set here. Reparsing rather than taking the caller's
    // word keeps one direction of truth: the URL is the state, this is just a cache of it.
    window.history.replaceState(window.history.state, '', hash);
    setRoute(parseHash(hash));
  }, []);

  return { route, replaceRoute };
}
