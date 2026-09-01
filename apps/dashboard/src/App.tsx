/**
 * The dashboard entry: the public landing-page path, or the authenticated dashboard shell and its
 * hash-routed views.
 *
 * `client` is a prop rather than something this component constructs, so component tests can drive
 * the whole app through `createFixtureDashboardClient` with no network. `main.tsx` is the only
 * place the real app's client is named, and it always names the HTTP one.
 */
import { useEffect, useRef } from 'react';
import logoUrl from './assets/icons/djobi-icon.svg';
import type { DashboardClient } from './lib/dashboardClient';
import { ThemeToggle, useThemePreference } from './lib/theme';
import { useApplicationStore } from './lib/useApplicationStore';
import { analyticsPath, listPath, loginPath, useHashRoute } from './lib/useHashRoute';
import { Analytics } from './views/Analytics';
import { ApplicationDetail } from './views/ApplicationDetail';
import { ApplicationsList } from './views/ApplicationsList';
import { LandingPage } from './views/LandingPage';
import { Login } from './views/Login';

export function App({ client }: { client: DashboardClient }) {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path === '/landing-page' ? <LandingPage /> : <DashboardApp client={client} />;
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
    updateStage,
    addNote,
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
    if (unauthorized && route.name !== 'login') {
      replaceRoute(loginPath(window.location.hash));
    }
  }, [unauthorized, route.name, replaceRoute]);

  async function handleSignIn(email: string, password: string) {
    await client.signIn(email, password);
    reload();
    replaceRoute(route.name === 'login' && route.from ? route.from : '#/');
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
            The same brand lockup on every route. Going back to an index route is the *page's*
            business, not the chrome's, so the back link lives at the top of the detail view beside
            the record it belongs to — see `ApplicationDetail`.

            The SVG rather than one of the PNGs: it stays crisp on a high-DPI display where a 26px
            raster wouldn't, and it's 642 bytes. It is emitted as a file rather than inlined as a
            data URI, because `index.html` references the same file for the favicon — so the two
            share one emitted asset and one cache entry. Same mark as the extension's icon; the
            PNGs beside it are byte-identical to `apps/extension/src/assets/icons/`.
          */}
          <a className="brand" href="#/" aria-label="djobi — all applications">
            <img className="brand__logo" src={logoUrl} alt="" width={26} height={26} />
            <span className="wordmark">djobi</span>
          </a>
          {/*
            A peer of the brand lockup, not something `.page` lays out: the nav belongs to the
            chrome that sits on every route, the same reason the brand link and theme toggle do.
          */}
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
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="page">
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
          {route.name === 'login' ? (
            <Login onSignIn={handleSignIn} />
          ) : loading ? (
            <p className="empty-state">Loading applications…</p>
          ) : loadError ? (
            <p className="empty-state empty-state--error" role="alert">
              Couldn’t load applications. {loadError}
            </p>
          ) : route.name === 'list' ? (
            <ApplicationsList
              applications={applications}
              filters={route.filters}
              shown={route.shown}
              onFiltersChange={(filters) =>
                // Back to one batch: the rows the user had revealed were rows of a different
                // result set, and `listPath`'s default is that first batch.
                replaceRoute(listPath(filters))
              }
              onShowMore={(shown) => replaceRoute(listPath(route.filters, shown))}
              onStageChange={(id, stage) => void updateStage(id, stage)}
            />
          ) : route.name === 'analytics' ? (
            <Analytics
              applications={applications}
              range={route.range}
              stage={route.stage}
              onFiltersChange={(range, stage) => replaceRoute(analyticsPath(range, stage))}
              getProfile={client.getProfile}
            />
          ) : application ? (
            <ApplicationDetail
              application={application}
              back={backTarget.current}
              onStageChange={(id, stage) => void updateStage(id, stage)}
              onAddNote={addNote}
            />
          ) : (
            <p className="empty-state">
              No application with that id.{' '}
              <a href={backTarget.current.href}>Back to {backTarget.current.label.toLowerCase()}</a>
              .
            </p>
          )}
        </main>
      </div>
    </>
  );
}
