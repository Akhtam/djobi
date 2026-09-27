/**
 * Hash-based routing for the dashboard: list, detail, analytics, profile, login and sign-up. Hash
 * rather than History API because the app is a static SPA with no server rewrites; hand-rolled
 * rather than `react-router` because a handful of routes doesn't justify the dependency.
 *
 * List filters and the revealed row count live in the URL, so they survive opening an application
 * and back/forward. `?show=` alone is dropped on document load (see {@link useHashRoute}).
 */
import { useCallback, useEffect, useState } from 'react';
import { ApplicationStageSchema } from '@djobi/shared';
import { DEFAULT_RANGE, RANGES, type Range } from './analytics';
import { REJECTION_FILTERS, stageFilterOf, type RejectionFilter, type StageFilter } from './stages';

/** Rows revealed per batch — the unit `?show=` counts in. */
export const PAGE_SIZE = 20;

/** What the list is narrowed to. Fields are "no filter" when empty/null. */
export interface ListFilters {
  /** Free text matched against company and role. Trimmed at the point of matching, not here. */
  query: string;
  /** A {@link StageFilter}: both rejections share one pill, so none selects only `rejected_ats`. */
  stage: StageFilter | null;
  /** An exact rejection outcome, used only while the combined Rejected stage is selected. */
  rejection?: RejectionFilter | null | undefined;
  /** Applied-date order. Newest-first is the default and is omitted from the URL. */
  sort?: 'oldest' | undefined;
}

/**
 * The list, narrowed by {@link ListFilters} and cut to `shown` rows. `shown` sits beside the
 * filters because a filter change resets it while revealing more doesn't.
 */
export type ListRoute = { name: 'list'; filters: ListFilters; shown: number };
/** One application's detail page. */
export type DetailRoute = { name: 'detail'; id: string };
/** The Analytics view: `?range=` plus the list's `?stage=` pill. */
export type AnalyticsRoute = { name: 'analytics'; range: Range; stage: StageFilter | null };
/**
 * The sign-in view. `from` is the full hash to return to after sign-in, or `null` when there's
 * none.
 */
export type LoginRoute = { name: 'login'; from: string | null };
/** The sign-up view. No `from`: a fresh account has nowhere to return to but the list. */
export type SignUpRoute = { name: 'signup' };
/** The account-profile editor — the same Profile the extension edits, reachable from the header. */
export type ProfileRoute = { name: 'profile' };
export type Route =
  ListRoute | DetailRoute | AnalyticsRoute | LoginRoute | SignUpRoute | ProfileRoute;

/**
 * A valid {@link Range}, or `null` for anything else — the same shape `stageFilterOf` answers in.
 */
function rangeOf(value: string | null): Range | null {
  return (RANGES as readonly string[]).includes(value ?? '') ? (value as Range) : null;
}

/**
 * The `?stage=` pill, parsed through the schema: invalid values mean no filter, and a stage without
 * its own pill (`rejected_ats`) maps to the pill it shares.
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
 * Parses a location hash into a {@link Route}. Anything unrecognised (including an empty hash) is
 * the list. `stage` and `range` are parsed through closed sets, so bad values fall back to
 * defaults. `?show=` is floored at one batch but not capped (the list caps it against the real
 * count).
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
 * The list path for `filters` and `shown` — the inverse of {@link parseHash}. Empty/default values
 * are omitted, so the unfiltered list is `#/`.
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

/** The Analytics path; `range` omitted at its default, like {@link listPath}. */
export function analyticsPath(range: Range, stage: StageFilter | null): string {
  const params = new URLSearchParams();
  if (range !== DEFAULT_RANGE) params.set('range', range);
  if (stage) params.set('stage', stage);
  const search = params.toString();
  return search ? `#/analytics?${search}` : '#/analytics';
}

/** The login path, carrying `from` (another path helper's output) unchanged. */
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
   * Rewrites the hash **in place**, with no history entry — for filter changes and Load more, so
   * Back isn't buried under near-identical entries. Opening an application is a real push.
   */
  replaceRoute(hash: string): void;
}

/**
 * The current route, synced with back/forward. `?show=` is stripped on mount, so a fresh load
 * starts at one batch while in-session navigation keeps the user's place. (Done here, not in
 * `parseHash`, which must keep reading it for Back to work.)
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
    // `replaceState` doesn't fire `hashchange`, so re-parse and set the route here.
    window.history.replaceState(window.history.state, '', hash);
    setRoute(parseHash(hash));
  }, []);

  return { route, replaceRoute };
}
