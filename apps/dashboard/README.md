# `apps/dashboard`

A local web app for browsing past Applications and tracking where each one has got to. Separate
from the extension: it needs no `chrome.*` API, so it stays out of the MV3 bundle and gets plain
Vite HMR.

```sh
pnpm dev:backend     # required — the dashboard has no data of its own
pnpm dev:dashboard
```

Port 5174, because 5173 is the extension dev server's `strictPort` and both usually run at once.

## The one seam

`src/lib/dashboardClient.ts` holds the `DashboardClient` interface and both implementations, the
same way `backendClient.ts` does in the extension. Everything above it — views, components, tests —
is written against the interface, never against `fetch`.

`httpDashboardClient` is what the app runs on, against three backend routes:

| Call               | Route                                            |
| ------------------ | ------------------------------------------------ |
| `listApplications` | `GET /applications`                              |
| `updateStage`      | `PATCH /applications/:id/stage?response=compact` |
| `addNote`          | `POST /applications/:id/notes?response=compact`  |

The write calls explicitly request compact acknowledgements because the store already has the full
Application and reconciles only the changed Stage or appended Note. Omitting the query parameter is
reserved for older clients that expect the full updated Application.

`createFixtureDashboardClient` serves `src/lib/fixtures.ts` from memory and applies writes to its
own copy. It is **test-only** — `main.tsx` does not import it, and there is no runtime flag to
select it. A flag that swaps the backend for fake data is a flag that can be left on, and an app
that looks like it is saving while writing to memory is worse than one that visibly can't reach its
backend.

## Structure

| Path                         | What                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `lib/dashboardClient.ts`     | The interface, the HTTP adapter, the fixture adapter                |
| `lib/useApplicationStore.ts` | One shared array of applications + optimistic writes                |
| `lib/useHashRoute.ts`        | `#/` and `#/applications/:id`                                       |
| `lib/stages.ts`              | Stage/category labels and order, taken from the schemas' `.options` |
| `views/`                     | `ApplicationsList`, `ApplicationDetail`                             |
| `components/`                | Stage controls, filter pills, notes log, note composer              |

Both views read from one array held above the router. A single-record fetch would give the list and
the detail page separate copies that can disagree after a write — see the comment in
`useApplicationStore.ts`.

## Tests

`pnpm --filter dashboard test`. `App.test.tsx` drives the whole app through the fixture client with
nothing mocked; the client seam is the only substitution.
