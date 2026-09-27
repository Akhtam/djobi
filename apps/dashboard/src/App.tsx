/**
 * The dashboard entry: the public landing page, or the authenticated shell and its hash-routed
 * views. `client` is a prop so tests use `createFixtureDashboardClient`; `main.tsx` names the real
 * one.
 */
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import logoUrl from './assets/icons/djobi-icon.svg';
import { AccountMenu } from './components/AccountMenu';
import type { ErrorInfo, ReactNode } from 'react';
import type { DashboardClient } from './lib/dashboardClient';
import { ThemeToggle, useThemePreference } from './lib/theme';
import { useApplicationStore } from './lib/useApplicationStore';
import { analyticsPath, listPath, loginPath, useHashRoute } from './lib/useHashRoute';
import { LandingPage } from './views/LandingPage';

// Split per view: the landing page is the homepage and stays in the entry chunk, while each
// dashboard view is fetched only when its route is first visited.
const Analytics = lazy(() => import('./views/Analytics').then((m) => ({ default: m.Analytics })));
const ApplicationDetail = lazy(() =>
  import('./views/ApplicationDetail').then((m) => ({ default: m.ApplicationDetail })),
);
const ApplicationsList = lazy(() =>
  import('./views/ApplicationsList').then((m) => ({ default: m.ApplicationsList })),
);
const Login = lazy(() => import('./views/Login').then((m) => ({ default: m.Login })));
const Profile = lazy(() => import('./views/Profile').then((m) => ({ default: m.Profile })));
const SignUp = lazy(() => import('./views/SignUp').then((m) => ({ default: m.SignUp })));

/**
 * Catches a view chunk that failed to load (usually a redeploy removed old hashed files) and shows
 * a reload prompt. `lazy` caches the rejection, so reloading is the only retry.
 */
class ViewLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Dashboard view failed to render', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="empty-state empty-state--error" role="alert">
        This page couldn’t load — the dashboard may have been updated.{' '}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </p>
    );
  }
}

/**
 * Whether the hash is a dashboard route (`#/…`) rather than none or a landing-page anchor
 * (`#product`).
 */
function isDashboardRoute(hash: string): boolean {
  return hash.startsWith('#/');
}

/**
 * The landing page at the bare path, the dashboard for `#/…` hashes — both served from one
 * `index.html`. Reacts to `hashchange`, since landing-page CTAs are hash-only navigations. The
 * landing page owns no client and makes no request, so no session check happens until the dashboard
 * is asked for.
 */
export function App({ client }: { client: DashboardClient }) {
  const [dashboardRoute, setDashboardRoute] = useState(() =>
    isDashboardRoute(window.location.hash),
  );

  useEffect(() => {
    function onHashChange() {
      setDashboardRoute(isDashboardRoute(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return dashboardRoute ? <DashboardApp client={client} /> : <LandingPage />;
}

function DashboardApp({ client }: { client: DashboardClient }) {
  const { theme, toggleTheme } = useThemePreference();
  const { route, replaceRoute } = useHashRoute();
  const {
    applications,
    loading,
    loadError,
    writeError,
    unauthorized,
    reportUnauthorized,
    updateStage,
    addNote,
    deleteNote,
    deleteApplication,
    createApplication,
    reload,
  } = useApplicationStore(client);

  /*
    A 401 from the store means the session is gone — routed to `#/login` here rather than left to
    render as a generic load/write failure. `route.name !== 'login'` is what stops this from firing
    again once there: `unauthorized` does not reset itself, only `reload()` (called after a
    successful sign-in) does, so without that guard every render on the login page would try to
    `replaceRoute` to itself.
  */
  useEffect(() => {
    // Not from `login`/`signup`: a visitor there has no session yet, and the store's 401 would
    // otherwise bounce them off the form.
    if (unauthorized && route.name !== 'login' && route.name !== 'signup') {
      replaceRoute(loginPath(window.location.hash));
    }
  }, [unauthorized, route.name, replaceRoute]);

  async function handleSignIn(email: string, password: string) {
    await client.signIn(email, password);
    reload();
    replaceRoute(route.name === 'login' && route.from ? route.from : '#/');
  }

  async function handleSignUp(email: string, password: string, name: string) {
    await client.signUp(email, password, name);
    reload();
    replaceRoute('#/');
  }

  /*
    `reportUnauthorized` (not a direct `replaceRoute`) does double duty: it's the same flag the
    store sets on a real 401, and the effect above already turns that into the `#/login` redirect —
    one path for "session is gone" regardless of who noticed first. `client.signOut()` is
    fire-and-forget-ish (awaited, but its failure doesn't block leaving): the local session is over
    either way once the user asked to leave, cookie-clearing response or not.
  */
  async function handleSignOut() {
    await client.signOut();
    reportUnauthorized();
  }

  const handleUnauthorized = useCallback(() => {
    reportUnauthorized();
  }, [reportUnauthorized]);

  /*
    Only navigates away on success — a failed delete reports `writeError` and leaves the candidate
    looking at the row it couldn't remove, rather than bouncing them back to a list that still
    (correctly) shows it.
  */
  async function handleDeleteApplication(id: string) {
    if (await deleteApplication(id)) replaceRoute(backTarget.current.href);
  }

  const application =
    route.name === 'detail' ? applications.find((a) => a.id === route.id) : undefined;

  /*
    Where the detail page's back link points, and what it calls that place. The browser's own Back
    already returns to the filtered index route — that is what the push/replace split in
    `useHashRoute` buys — but the in-page link has no history to read, so it needs the last index
    URL handed to it. A ref rather than state: it only ever feeds the next render's href and must
    not cause one of its own.

    Written by whichever index route rendered last (Applications or Analytics), so a posting opened
    from the Analytics requirements panel returns there with its range and stage intact rather than
    being sent to the applications list by a hard-coded default.

    Deep-linking straight into a detail page leaves it at its initial default, which is the right
    answer there: there is no filtered index page to go back to.
  */
  const backTarget = useRef({ href: '#/', label: 'Applications' });
  if (route.name === 'list') {
    backTarget.current = { href: listPath(route.filters, route.shown), label: 'Applications' };
  } else if (route.name === 'analytics') {
    backTarget.current = { href: analyticsPath(route.range, route.stage), label: 'Analytics' };
  }

  const publicAuthRoute = route.name === 'login' || route.name === 'signup';

  return (
    <>
      {/*
        The header sits outside `.page`, not inside it. `.page` is capped at 960px, so a sticky
        translucent bar within it stops at that cap and reads as a floating box over the page
        background rather than as a bar. Full-bleed element, constrained inner row.
      */}
      <header className="page-header">
        <div className="page-header__inner">
          {/*
            The same brand lockup on every route. On login and signup it returns to the public
            landing page; once signed in it returns to the applications index. Going back to an
            index route is otherwise the *page's* business, not the chrome's, so the back link lives
            at the top of the detail view beside the record it belongs to — see `ApplicationDetail`.

            The SVG rather than one of the PNGs: it stays crisp on a high-DPI display where a 26px
            raster wouldn't, and it's 642 bytes. It is emitted as a file rather than inlined as a
            data URI, because `index.html` references the same file for the favicon — so the two
            share one emitted asset and one cache entry. Same mark as the extension's icon; the
            PNGs beside it are byte-identical to `apps/extension/src/assets/icons/`.
          */}
          <a
            className="brand"
            href={publicAuthRoute ? '/' : '#/'}
            aria-label={publicAuthRoute ? 'djobi home' : 'djobi — all applications'}
          >
            <img className="brand__logo" src={logoUrl} alt="" width={26} height={26} />
            <span className="wordmark">djobi</span>
          </a>
          {/*
            A peer of the brand lockup, not something `.page` lays out: the nav belongs to the
            chrome that sits on every route, the same reason the brand link and theme toggle do.
          */}
          {!publicAuthRoute ? (
            <nav className="nav" aria-label="Views">
              <a
                className="nav-link"
                href="#/"
                aria-current={route.name === 'list' ? 'page' : undefined}
              >
                Applications
              </a>
              <a
                className="nav-link"
                href="#/analytics"
                aria-current={route.name === 'analytics' ? 'page' : undefined}
              >
                Analytics
              </a>
            </nav>
          ) : null}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {/*
            Hidden on `login`/`signup`: those routes render before a session exists (a fresh
            visitor's own load 401s immediately, same reasoning as the redirect effect above), so
            an account menu there would act on a session that isn't there yet.
          */}
          {!publicAuthRoute ? (
            <AccountMenu client={client} onSignOut={() => void handleSignOut()} />
          ) : null}
        </div>
      </header>

      <div className={`page ${route.name === 'list' ? 'page--applications' : ''}`}>
        {/*
        A failed write is recoverable and must not replace the view — the user's change was
        reverted and they can retry. It is announced instead, above whatever they were looking at.
      */}
        {writeError ? (
          <p className="banner banner--error" role="alert">
            {writeError}
          </p>
        ) : null}

        <main>
          <ViewLoadBoundary>
            <Suspense fallback={<p className="empty-state">Loading…</p>}>
              {route.name === 'login' ? (
                <Login onSignIn={handleSignIn} />
              ) : route.name === 'signup' ? (
                <SignUp onSignUp={handleSignUp} />
              ) : route.name === 'profile' ? (
                <Profile
                  getProfile={client.getProfile}
                  saveProfile={client.saveProfile}
                  extractResume={client.extractResume}
                  onUnauthorized={handleUnauthorized}
                />
              ) : loading ? (
                <p className="empty-state">Loading applications…</p>
              ) : loadError ? (
                <p className="empty-state empty-state--error" role="alert">
                  Couldn’t load applications. {loadError}
                </p>
              ) : route.name === 'list' ? (
                <ApplicationsList
                  applications={applications}
                  client={client}
                  filters={route.filters}
                  shown={route.shown}
                  onFiltersChange={(filters) =>
                    // Back to one batch: the rows the user had revealed were rows of a different
                    // result set, and `listPath`'s default is that first batch.
                    replaceRoute(listPath(filters))
                  }
                  // Reordering, not filtering: `shown` carries over (see `ApplicationsList`).
                  onSortChange={(sort) =>
                    replaceRoute(listPath({ ...route.filters, sort }, route.shown))
                  }
                  onShowMore={(shown) => replaceRoute(listPath(route.filters, shown))}
                  onStageChange={(id, stage) => void updateStage(id, stage)}
                  onCreateApplication={createApplication}
                  onUnauthorized={handleUnauthorized}
                />
              ) : route.name === 'analytics' ? (
                <Analytics
                  applications={applications}
                  range={route.range}
                  stage={route.stage}
                  onFiltersChange={(range, stage) => replaceRoute(analyticsPath(range, stage))}
                  getProfile={client.getProfile}
                  onUnauthorized={handleUnauthorized}
                />
              ) : application ? (
                <ApplicationDetail
                  application={application}
                  back={backTarget.current}
                  onStageChange={(id, stage) => void updateStage(id, stage)}
                  onAddNote={addNote}
                  onDeleteNote={(id, noteId) => void deleteNote(id, noteId)}
                  onDeleteApplication={(id) => void handleDeleteApplication(id)}
                />
              ) : (
                <p className="empty-state">
                  No application with that id.{' '}
                  <a href={backTarget.current.href}>
                    Back to {backTarget.current.label.toLowerCase()}
                  </a>
                  .
                </p>
              )}
            </Suspense>
          </ViewLoadBoundary>
        </main>
      </div>
    </>
  );
}
