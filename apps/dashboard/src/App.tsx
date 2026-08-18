/**
 * The dashboard shell: theme, the one application store, and the route switch between the two
 * views.
 *
 * `client` is a prop rather than something this component constructs, so component tests can drive
 * the whole app through `createFixtureDashboardClient` with no network. `main.tsx` is the only
 * place the real app's client is named, and it always names the HTTP one.
 */
import logoUrl from './assets/icons/djobi-icon.svg';
import type { DashboardClient } from './lib/dashboardClient';
import { ThemeToggle, useThemePreference } from './lib/theme';
import { useApplicationStore } from './lib/useApplicationStore';
import { useHashRoute } from './lib/useHashRoute';
import { ApplicationDetail } from './views/ApplicationDetail';
import { ApplicationsList } from './views/ApplicationsList';

export function App({ client }: { client: DashboardClient }) {
  const { theme, toggleTheme } = useThemePreference();
  const route = useHashRoute();
  const { applications, loading, loadError, writeError, updateStage, addNote } =
    useApplicationStore(client);

  const application =
    route.name === 'detail' ? applications.find((a) => a.id === route.id) : undefined;

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
            The same brand lockup on every route. Going back to the list is the *page's* business,
            not the chrome's, so the back link lives at the top of the detail view beside the
            record it belongs to — see `ApplicationDetail`.

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
          {loading ? (
            <p className="empty-state">Loading applications…</p>
          ) : loadError ? (
            <p className="empty-state empty-state--error" role="alert">
              Couldn’t load applications. {loadError}
            </p>
          ) : route.name === 'list' ? (
            <ApplicationsList
              applications={applications}
              onStageChange={(id, stage) => void updateStage(id, stage)}
            />
          ) : application ? (
            <ApplicationDetail
              application={application}
              onStageChange={(id, stage) => void updateStage(id, stage)}
              onAddNote={addNote}
            />
          ) : (
            <p className="empty-state">
              No application with that id. <a href="#/">Back to all applications</a>.
            </p>
          )}
        </main>
      </div>
    </>
  );
}
