/**
 * Hash-based routing for the dashboard's two views.
 *
 * Hash rather than the History API because this app is served as a static SPA with no server
 * rewrite rule: a real path deep link would 404 before React ever ran. Hand-rolled rather than
 * `react-router` because two routes do not pay for the dependency — the extension pulls in only
 * React, and this app should look like it belongs to the same repo.
 */
import { useEffect, useState } from 'react';

/** The list of applications. */
export type ListRoute = { name: 'list' };
/** One application's detail page. */
export type DetailRoute = { name: 'detail'; id: string };
export type Route = ListRoute | DetailRoute;

/**
 * Parses a location hash into a {@link Route}.
 *
 * Anything unrecognised — including the empty hash a first visit arrives with — is the list. A
 * dashboard that renders "not found" because a URL has no fragment would be a worse answer than
 * showing the user their applications.
 */
export function parseHash(hash: string): Route {
  const match = /^#\/applications\/([^/?#]+)$/.exec(hash);
  if (match) return { name: 'detail', id: decodeURIComponent(match[1]) };
  return { name: 'list' };
}

/** The path for one application's detail view — the single place this URL shape is written. */
export function applicationPath(id: string): string {
  return `#/applications/${encodeURIComponent(id)}`;
}

/** The current route, kept in sync with the browser's back/forward buttons. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
    }

    // Re-read on mount as well as on change: the hash can be set between the initial `useState`
    // and this effect running, and a route read once at render time would miss it.
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
