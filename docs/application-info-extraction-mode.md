# Application-info extraction mode — design research

> **Status: superseded in part (2026-08-18).** The narrower feature the candidate actually wanted —
> logging an application they made by hand, so it joins the same history — was built instead, as the
> panel's **Log** tab (see `PROGRESS.md`, Phase 9a). It needed no new endpoint, no new LLM call and
> no new pipeline: `POST /extract-job` for the details, `POST /applications` with `source: 'manual'`,
> and the base profile in place of a tailored resume. This document's tab-vs-toggle recommendation
> was adopted; its Application Kit, `POST /fetch-posting` and `POST /application-kit` were not.
>
> What remains live here is the part still unbuilt: **reading a posting the extension isn't looking
> at** — from a pasted URL, or off an open LinkedIn Easy Apply modal — and the host-permission,
> MV3 and LinkedIn-ToS constraints on doing so.
>
> **Snapshot scope:** §§1–8 are the pre-Log-tab research snapshot. Present-tense descriptions in
> those sections describe the implementation at the time of research, before the panel gained its
> persistent **Autofill / Log** tab switcher; they are preserved as design history, not claims about
> the current tree. Current implementation corrections are called out where they affect a live
> recommendation.
>
> Every repo claim below is `path:line`; every external claim carries its primary-source URL. Line
> numbers predate the Log tab and may have shifted.

## 1. The question, restated

At the time of this research, the extension had exactly one flow: the candidate pasted a Job
Description into the side panel, the Analysis Step turned it into Job Info + a Tailored Resume +
drafted Question Answers, and the Fill Step wrote them into the ATS form on the current page. The
current panel also has a separate **Log** flow for recording manually submitted applications.

The ask is a **second mode**: instead of producing a tailored resume for a form the extension is
sitting on, the extension should **extract everything a human needs in order to fill out a job
application** — from any of three inputs:

- **(a)** a pasted job description,
- **(b)** a job posting URL, and
- **(c)** "just LinkedIn Easy Apply" — the candidate is sitting on an Easy Apply modal and wants the
  fields prepared/answered.

Two sub-questions:

1. Is the second mode a **tab** in the side panel, or a **toggle**?
2. What is the right architecture given the code that already exists?

One thing the brief leaves genuinely open, and which changes the answer to nearly everything below:
**what "all the info needed" means as an artifact.** Is it (i) the _values_ — name, email, work
authorization, per-question drafts — presented for copy-out; (ii) the Analysis Step's output minus
the Fill Step, i.e. today's pipeline that stops before touching the page; or (iii) a _reconnaissance_
report — "here is what this employer will ask you, and here's what you'd say." This doc assumes (i)
with a dash of (iii), and flags the choice in §7.

---

## 2. How the extension worked before the Log tab

### 2.1 Surfaces and the manifest

MV3, built by `@crxjs/vite-plugin` from a TypeScript manifest
(`apps/extension/vite.config.ts:11`, `apps/extension/src/manifest.ts:8`).

- **Side panel** is the only review surface. `manifest.ts:28` declares
  `side_panel.default_path: 'src/panel/index.html'`, and `manifest.ts:18` deliberately declares
  **no `default_popup`** — the toolbar icon opens the panel instead, wired by
  `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` at
  `apps/extension/src/background/service-worker.ts:18`. The stated reason (`manifest.ts:19-21`,
  `PROGRESS.md` "Review surface is a side panel, not a popup") is that a popup dies on any outside
  click while a panel survives tab switches.
- **Options page** (`manifest.ts:31`) edits the Profile — `apps/extension/src/options/App.tsx`.
- **Content script** runs on `http://*/*` + `https://*/*`, `all_frames: true`
  (`manifest.ts:36-47`). Deliberately _not_ an ATS host allowlist, because ATS vendors let companies
  white-label a board onto their own domain; `docs/ats-platform-detection.md:8-13` records that
  `lib/atsHosts.ts` was deleted for exactly this reason.
- **Host permissions** are narrow and enumerated (`manifest.ts:48-56`): the local backend
  `http://127.0.0.1:5391/*`, plus three ATS APIs (`boards-api.greenhouse.io`,
  `api.smartrecruiters.com`, `*.workable.com`). There is **no `optional_host_permissions` key at
  all**, and no permission that would let the extension fetch an arbitrary pasted URL.
- **Permissions** (`manifest.ts:59`): `storage`, `scripting`, `activeTab`, `sidePanel`, `tabs`. The
  comment at `manifest.ts:57-58` records why `tabs` is there and not just `activeTab`: `activeTab`
  is revoked on navigation, and the panel needs `Tab.url` to follow an application through an ATS
  flow.

### 2.2 The single side-panel document

`apps/extension/src/panel/App.tsx` is the panel's whole content, mounted by `panel/main.tsx`. It is
a **single flow keyed off one status union**:

```ts
type Status = 'loading' | 'no-profile' | 'ready' | PipelineStatus; // App.tsx:41
```

`'loading' | 'no-profile' | 'ready'` are panel-local bootstrap states; the rest is `PipelineStatus`
from the store (`apps/extension/src/lib/tabStore.ts:23-33`). In this snapshot there was **no tab
switcher, no router, no mode state** — `App.tsx:229-488` was a sequence of `{status === X && …}`
blocks inside one `.panel-body`. The current panel has an `Autofill` / `Log` switcher while the
Autofill pane retains this status-driven pipeline. What each pipeline status _means_ (the header
pill, whether the review stays up, how the fill went) is derived once in
`apps/extension/src/lib/runReview.ts:75` (`reviewOf`), specifically so the panel doesn't re-derive it
per branch.

The panel follows the active browser tab rather than remounting, via
`apps/extension/src/panel/useActiveTab.ts:28` — `chrome.tabs.query` at startup plus
`onActivated`/`onUpdated` listeners, with a `changeToken` that increments on a tab switch _and_ on a
same-tab navigation (`useActiveTab.ts:54-59`). `App.tsx:96-115` uses that token to drop everything
scoped to the previous page.

### 2.3 Storage model

Everything about one browser tab lives under one `chrome.storage.session` key,
`` `tab:${tabId}` `` (`tabStore.ts:146`). The entry holds per-frame detection plus at most one
pipeline run (`TabState`, `tabStore.ts:130-134`). Writes go through an in-memory per-tab queue
(`withTabLock`, `tabStore.ts:212`) and `chrome.tabs.onRemoved` clears the key
(`tabStore.ts:333-337`). `session` storage was chosen because it survives service-worker eviction
but not a browser restart (`tabStore.ts:16-21`).

Storage is keyed by browser tab, while each attempt inside that entry has a unique `runId`.
Asynchronous patches require both identities, so an older completion cannot mutate a replacement
run. A future extraction started from a pasted URL would still need a storage owner other than an
ATS tab.

### 2.4 Message passing

Two protocols, deliberately separate:

- **`TypedMessage`** (`apps/extension/src/lib/messages.ts:122`) — notification-only, no responses:
  `REPORT_JOB_PAGE`, `START_ANALYSIS`, `START_FILL`, `START_SAVE_APPLICATION`, and `UPDATE_RUN`. The doc comment at
  `messages.ts:104-121` explains why: holding a message channel open until an Analysis Step finishes
  is exactly the failure the design avoids, since the channel dies with the panel. Progress is read
  from `tabStore` via `chrome.storage.onChanged` (`panel/usePipelineRun.ts`).
- **`ContentCommandMessage`** (`messages.ts:102`) — the two request/response messages,
  `SCAN_PAGE` and `FILL_FORM`, sent through `apps/extension/src/lib/pageClient.ts:84`.

The service worker's `onMessage` listener (`service-worker.ts:22`) returns nothing on purpose and
hands off to `background/router.ts:17`.

**Frame addressing is load-bearing.** `pageClient.ts:67` (`ask`) takes an optional `frameId`, and
`tabStore.ts:284` (`getDetectedFrame`) picks the frame with the most detected fields. Without the
`frameId`, `chrome.tabs.sendMessage` delivers to _every_ frame and resolves with whichever answers
first — and an invisible hCaptcha or tag-manager iframe answers `FILL_FORM` with an empty result
before the real form finishes verifying (`pageClient.ts:57-66`, `PROGRESS.md` "Constraints that
look like mistakes"). `content/index.ts:85` staying silent when a frame holds no fields is the
backstop.

### 2.5 The pipeline

`apps/extension/src/background/applicationPipeline.ts` runs in the service worker so a step
survives the panel closing (`applicationPipeline.ts:1-17`).

- `runAnalysis` (`applicationPipeline.ts:358`) — stores a new identified run first, then performs the
  duplicate guard (`findDuplicate`, deliberately fails open) and `analysisStep`; every later patch
  is conditional on that `runId` still being current.
- `analysisStep` (`applicationPipeline.ts:88`) — `extractJob(jobDescription)`, then filters the
  page's `question`-category Detected Fields into `PendingQuestion`s (`:96-105`), then
  `splitPreparedQuestions(profile, questions)` (`:109`) resolves everything the Profile already
  answers _without a model call_, then `tailorResume` + `answerQuestions` in parallel (`:111-114`),
  then re-orders answers back into page order (`:126-131`).
- `fillStep` (`applicationPipeline.ts:145`) — re-scans the live page (`:170-175`),
  `carryEnrichment` to keep API-supplied options over a fresh DOM scan (`:180`), maps
  `valueForCategory` for scalar fields (`:59`, `:193`), renders the resume PDF only if a
  `resume_upload` field exists (`:201-208`), fills, and reports what the page verifiably kept when a
  frame responds. With no response it retains attempted counts and marks the outcome `unverified`.
- `runSaveApplication` (`applicationPipeline.ts:264`) — explicit, separate from filling.

### 2.6 Detection, classification and the ATS oracle

- `content/detect.ts:23` (`isJobApplicationPage`) — a page-shape heuristic: a file input, or a
  control labelled resume/CV/cover letter/LinkedIn. `content/detect.ts:66`
  (`watchForJobApplicationPage`) re-reports on every settled DOM change and re-arms on client-side
  route changes via a `location.href` poll (`:116-121`) — written up in `detect.ts:40-64` because
  Ashby's posting → `/application` transition is a `pushState`, so no new content script runs.
- `content/detectFields.ts:956` (`detectFields`) — 998 lines of generic heuristic classification
  into `FieldCategory` (`packages/shared/src/detectedField.ts:30-44`) and `ElementRole`
  (`detectedField.ts:58`). Handles react-select comboboxes, `<fieldset>` radio/checkbox groups as
  _one_ field, required-marker stripping, and enclosing `role="group"` names.
- `background/apiDetectors.ts:412` — three `AtsOracle` adapters (Greenhouse, SmartRecruiters,
  Workable) that fetch the ATS's own published form schema and _enrich_ the DOM scan with `required`
  flags and option labels. The oracle is an oracle only: "The DOM pass is always the baseline"
  (`apiDetectors.ts:12-17`).

### 2.7 The Greenhouse commit (`acc42da`)

`git show acc42da` — "Fix five silent failures behind Greenhouse autofill." Worth reading for this
design because four of the five defects are _classification_ bugs that a new extraction mode would
inherit verbatim, since it will consume the same `DetectedField[]`:

1. the `location` keyword rule matched question prose, so yes/no screening questions were filled
   with the candidate's city;
2. both file inputs signalled Greenhouse's visually-hidden "Attach" label, so the cover-letter slot
   became a second resume candidate;
3. the question-shape gate only covered `<textarea>`, but Greenhouse renders free-response questions
   as `<input type="text">` — four fields classified `unknown` and never drafted;
4. the oracle only recognized `*.greenhouse.io/{board}/jobs/{id}`, so a white-labeled URL reached no
   oracle and 13 comboboxes stayed choice-less;
5. `normalizeLabel` didn't strip the required asterisk, so 0 of 19 API questions matched a field.

The commit's own framing — "nothing about this form was hard to detect; five independent defects
each failed _silently_" — is the risk model for extraction mode too. An extraction that silently
omits a question looks identical to a form that didn't ask it.

### 2.8 Backend

Hono on `127.0.0.1:5391` (`apps/backend/src/app.ts:17`). Six route groups (`app.ts:121-126`).
Three LLM calls, each a thin route over one module:

| Route                                                     | Module                      | Model                       |
| --------------------------------------------------------- | --------------------------- | --------------------------- |
| `POST /extract-job` (`routes/extract-job.ts:9`)           | `llm/extractJob.ts:19`      | `MODELS.extraction` (Haiku) |
| `POST /tailor-resume` (`routes/tailor-resume.ts`)         | `llm/tailorResume.ts`       | `MODELS.writing` (Sonnet)   |
| `POST /answer-questions` (`routes/answer-questions.ts:9`) | `llm/answerQuestions.ts:54` | `MODELS.writing`            |

All three go through `llm/structuredCall.ts` — a forced tool call validated with zod, because the
installed SDK has no `.messages.parse()` (`PROGRESS.md` "Structured output workaround").

Two app-level guards matter to any new route: CORS is an explicit allowlist for the dashboard only
(`app.ts:41-48`), and **every state-changing request must declare
`content-type: application/json`** as a CSRF guard (`app.ts:65-81`) — a POST with `text/plain` is a
CORS "simple request" and would reach the handler unpreflighted.

### 2.9 Shared types

`packages/shared/src/wire.ts` owns operation-specific transport schemas and aliases; reusable domain
write shapes such as `NewApplicationSchema` and `ApplicationSnapshotSchema` stay in `schemas.ts`.
The shared contracts prevent zod's `.object()` stripping a sender-only field in transit — which is
what once happened to `knownAnswer` — and `backendClient.ts` builds bodies with `satisfies` against
them.

Relevant shapes: `JobInfoSchema` (`schemas.ts:148`), `TailoredResumeSchema` (`schemas.ts:169`),
`QuestionAnswerSchema` (`schemas.ts:194`, whose `fieldId` "Matches DetectedField.id"),
`PendingQuestionSchema` / `QuestionForModelSchema` (`wire.ts:34`, `wire.ts:54`),
`DetectedFieldSchema` (`detectedField.ts:85`), `SCREENING_TOPICS`
(`packages/shared/src/screeningAnswers.ts:26`), and `splitPreparedQuestions`
(`packages/shared/src/preparedAnswers.ts:74`).

### 2.10 What's already planned

At the time of research, `PROGRESS.md` → **Phase 9 (Ask tab)** committed to this, verbatim:

> **The panel becomes tabbed.** At the time of this research, `panel/App.tsx` rendered one flow keyed
> off `status`. The shipped Log work added the tab switcher; any future Ask surface would extend that
> existing switcher as a third tab.

That planned navigation idiom has since landed for **Autofill / Log**. Any future extraction surface
should extend the existing tab shell rather than introduce a separate mode toggle.

---

## 3. Reuse vs genuinely new

### Reusable as-is

| Thing                               | Where                                                 | How extraction mode uses it                                               |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Job Info extraction                 | `llm/extractJob.ts:19` via `POST /extract-job`        | Identical — input is still posting text                                   |
| Prepared-answer resolution          | `preparedAnswers.ts:74`, `screeningAnswers.ts:26`     | Answers work auth / sponsorship / notice period with **zero model calls** |
| Answer drafting                     | `llm/answerQuestions.ts:54`                           | Same prompt, same non-fabrication rule, same `knownAnswer` handling       |
| Profile → scalar values             | `applicationPipeline.ts:59` (`valueForCategory`)      | The name/email/phone/links half of "all the info needed"                  |
| Field detection + classification    | `detectFields.ts:956`                                 | Reads the Easy Apply modal exactly as it reads a Greenhouse form          |
| On-demand re-scan                   | `SCAN_PAGE` / `pageClient.scan` (`pageClient.ts:101`) | The Easy Apply input source _is_ a `SCAN_PAGE`                            |
| Frame-addressed messaging           | `pageClient.ts:67`, `tabStore.ts:284`                 | LinkedIn's modal is same-frame, but the rule still applies                |
| Backend transport + wire discipline | `callBackend.ts:93`, `backendClient.ts:56`, `wire.ts` | New route slots straight in                                               |
| Background-run + checkpoint pattern | `applicationPipeline.ts`, `usePipelineRun.ts`         | Same reason: survives the panel closing                                   |
| Resume PDF render                   | `POST /render-resume-pdf`                             | Only if extraction mode still emits a resume (open question)              |

### Genuinely new

1. **Panel navigation.** This was net-new in the snapshot; the current panel now has an
   **Autofill / Log** switcher and keeps both panes mounted so in-flight work and typed input survive
   a switch. Extraction would extend that shell rather than invent navigation, but still needs a
   persistence decision for its own run state.
2. **A run that isn't keyed to a browser tab.** `tabStore.ts:146` keys everything `tab:${tabId}`.
   A pasted-URL extraction has no ATS tab.
3. **Fetching an arbitrary URL.** Nothing in the extension does this. `manifest.ts:48-56` grants
   four specific hosts; there is no `optional_host_permissions`.
4. **Reading a posting off a page.** Explicitly reversed as a design decision — `PROGRESS.md`: "The
   Job Description is pasted, never scraped", and `messages.ts:3-14` records the removal of
   `pageText`. LinkedIn Easy Apply is the one case where the posting and the form _are_ the same
   page, which is a real reason to reopen it **for LinkedIn only**.
5. **A "what will they probably ask?" prediction.** With no form on screen (pasted JD, pasted URL),
   there are no Detected Fields, so there's nothing for `answerQuestions` to key off. Predicting the
   question set is a new model call with a new output shape.
6. **An output artifact that isn't a filled form.** Today the terminal action is "Fill form" then
   "Save application" (`App.tsx:491-516`). Extraction mode's terminal action is copy-out.
7. **A `QuestionAnswer` with no field.** `QuestionAnswerSchema.fieldId` is required and documented
   as "Matches DetectedField.id" (`schemas.ts:195`). A predicted question has no field.

---

## 4. Tab vs toggle

### The API facts this rests on

Chrome's Side Panel API supports more than most people assume, and less than would make a
"second panel" the right lever:

- The panel is set from `side_panel.default_path` in the manifest, "to display the same side panel on
  every site."
  ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
- `sidePanel.setOptions({ tabId, path, enabled })` — "If specified, the side panel options will only
  apply to the tab with this id. If omitted, these options set the default behavior (used for any
  tab that doesn't have specific settings)."
  ([sidePanel reference, `PanelOptions`](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
- Crucially, from the same `PanelOptions.tabId` entry: **"Note: if the same path is set for this
  tabId and the default tabId, then the panel for this tabId will be a different instance than the
  panel for the default tabId."** Panel documents are instanced per (path, tab-scope) — switching
  scope means a different document, not a preserved one.
- `sidePanel.open({ tabId | windowId })` — "This may only be called in response to a user action";
  "Use `windowId` to open a global side panel. Alternatively, set the `tabId` to open the side panel
  only on a specific tab."
  ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
- The docs do ship a "Multiple side panels" sample, and describe swapping paths at runtime:
  "sets a welcome side panel on `runtime.onInstalled()`. Then when the user navigates to a different
  tab, it replaces it with the main side panel."
  ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
- Lifecycle across tab switches: "The side panel remains open when navigating between tabs (if set
  to do so)"; "When a user temporarily switches to a tab where the side panel is not enabled, the
  side panel will be hidden. It will automatically show again when the user switches to a tab where
  it was previously open"; "When the user navigates to a site where the side panel is not enabled,
  the side panel will close, and the extension won't show in the side panel drop-down menu."
  ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))
- Side panels are extension pages: "As an extension page, side panels have access to all Chrome
  APIs."
  ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel))

**What that means for this question.** "Multiple panels" is real but is _path switching driven by
browser-tab identity_, not by user intent, and each switch is a fresh document instance. The user's
choice of mode is not a property of the browser tab. So the mode switch must not be implemented at
the `sidePanel` API level at all — it belongs _inside_ the one panel document. The remaining choice
is therefore genuinely a UI one: tab switcher vs toggle.

### RECOMMENDATION: a tab

Use a tab in the panel, with the Autofill flow and the new mode as separate panes ("Prepare" /
"Extract"). The original recommendation was to add a switcher above `.panel-body`; that switcher has
since landed for **Autofill / Log**, including the important behavior of keeping both panes mounted.
Extraction should add to that established navigation idiom rather than add a toggle.

Why a tab and not a toggle:

1. **The two modes don't share a run.** A toggle reads as "same flow, one parameter flipped", which
   would push both shapes through one `PipelineStatus` union (`tabStore.ts:23-33`) and one
   `reviewOf` derivation (`runReview.ts:75`). They aren't the same shape: today's flow is
   `analyzing → review → filling → filled → saving → saved` with `unresolvedRequiredFields`,
   `filledFieldCount` and `fillOutcome` hanging off it; extraction has no fill and no page. Every
   one of `runReview.ts`'s branches would need a "…unless we're in extract mode" arm — which is
   precisely the six-way duplication `runReview.ts:7-15` was created to kill.
2. **They have different preconditions.** Today's flow needs a browser tab with a detected form; the
   panel's `ready` copy is written around that (`App.tsx:250-277`), `handleAnalyze` bails without a
   `tabUrl` (`App.tsx:144`), and `runAnalysis` reads `getDetectedPage(tabId)` (`applicationPipeline.ts:368`).
   Extraction from a pasted URL needs **none** of that. A toggle sitting inside a surface whose
   whole framing is "this page" makes the no-page case look like a degraded state rather than a
   first-class one.
3. **A toggle implies destructiveness; a tab implies coexistence.** Flipping a toggle mid-review
   reads as "am I about to lose my drafted answers?" Two tabs are obviously two things that both
   exist. Since the panel already checkpoints every state so closing it mid-run loses nothing
   (`PROGRESS.md` "Current state"), coexistence is the honest representation.
4. **It has to extend to three, not two.** Phase 9 (Answer chat) is planned as a third tab. A
   toggle is a two-state control by construction; adding Ask would then require a tab switcher _and_
   a toggle in one 400px-wide panel.
5. **Different terminal actions.** Today's footer is Fill / Save (`App.tsx:491-516`) and is
   conditional on `canReview && jobInfo && tailoredResume`. Extraction's terminal action is copy-out.
   A footer that changes meaning under a toggle is a well-known mis-click generator; tabs scope
   their own footers naturally.

### Runner-up: a toggle — and why it loses

A toggle is genuinely better on one axis: **cheapness**. It's a boolean in `App.tsx`, needs no
route/tab state, no decision about what survives a switch, and no new persisted key. If the second
mode were literally "run the same Analysis Step but stop before Fill" — interpretation (ii) from
§1 — a toggle would be the right call, because then it _is_ one flow with one step suppressed, and
splitting it into tabs would duplicate the paste box, the duplicate guard, and the review UI.

It loses because the brief's three input sources rule that reading out. The moment a pasted **URL**
and a **LinkedIn Easy Apply modal** are inputs, the second mode has its own input surface, its own
preconditions (no tab, no detected form), and its own output artifact. That is a second flow wearing
a toggle, and the cost lands as conditional arms scattered through `runReview.ts`, `tabStore.ts` and
`App.tsx` — exactly the shape those modules were refactored to remove.

### A third option, explicitly rejected

**Per-tab `setOptions({ tabId, path })` to swap the panel document by host** — e.g. a LinkedIn-only
panel on `linkedin.com`. It is supported (see the API facts above), but: the swap is keyed to the
browser tab rather than to what the user wants to do; the new path is a _different instance_, so
in-flight React state is gone; and disabling a panel per host makes the extension "close, and the
extension won't show in the side panel drop-down menu"
([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)) —
which would make djobi _disappear_ on non-job pages. Not worth it.

---

## 5. Proposed architecture

### 5.1 The shape of the thing

One new concept, which should get a `CONTEXT.md` entry before any code lands (per
`docs/agents/domain.md`): an **Application Kit** — everything a candidate needs to fill an
application by hand, derived from a posting and the Profile, with no page write and no Fill Step.
It sits beside "Application Pipeline" in the glossary, not inside it.

Its production is one flow with a **swappable front end** and a **shared back end**:

```
                       ┌────────────────────────┐
 (a) pasted JD text ──►│                        │
 (b) pasted URL     ──►│  normalize to posting  │──► extractJob ──► JobInfo ──┐
 (c) Easy Apply page ─►│  text (+ questions?)   │                             │
                       └────────────────────────┘                             │
                                    │ questions (c only, or predicted)        │
                                    ▼                                         ▼
                       splitPreparedQuestions ──► answerQuestions ──► Application Kit
                       (Profile, no model)         (model)              (panel, copy-out)
```

Everything downstream of "normalize" is the code that already exists. The three input sources differ
only in how the posting text (and, for (c), the question list) is obtained.

### 5.2 Input source (a): pasted job description

Unchanged from today, minus the tab requirement. The panel holds the text locally, dispatches a new
notification-only message `START_EXTRACTION`, and the service worker runs it.

- **Panel:** textarea, same `??`-vs-`||` discipline the existing box needs (`PROGRESS.md`
  "Constraints that look like mistakes" — display value, disabled check and payload must read the
  same expression, or the box silently reverts typing).
- **Service worker:** new `background/extractionPipeline.ts`, mirroring
  `applicationPipeline.ts`'s "run in the worker, checkpoint into storage" contract
  (`applicationPipeline.ts:1-17`).
- **Backend:** reuse `POST /extract-job`; add `POST /application-kit`.

### 5.3 Input source (b): pasted job posting URL

This is the only source that needs a capability the extension doesn't have. Three ways to get the
posting text, with real trade-offs:

**Option B1 — the backend fetches the URL. RECOMMENDED.**
`apps/backend` is a local Node process. It has no same-origin policy, no `host_permissions`, and it
already holds the Anthropic key and the LLM calls. A new `POST /fetch-posting` takes `{ url }`,
fetches, strips boilerplate to text, and returns `{ jobDescription, sourceUrl, finalUrl, title }` —
with no LLM call, so a failure is cheap and legible.

- Pro: zero manifest change, zero permission prompt, no MV3 DOM problem.
- Con: **no browser session.** A posting behind auth (LinkedIn job pages, most Workday tenants,
  anything behind Cloudflare) returns a login wall or a challenge, not a posting. The route must
  detect that and say so, not hand a login page to `extractJob` — otherwise the failure looks
  exactly like the "scrape captured the nav bar" problem that killed page scraping in the first
  place (`messages.ts:3-14`).
- Con: the local backend becomes an unauthenticated fetch proxy for any origin that can reach
  `127.0.0.1:5391`. The existing content-type CSRF guard (`app.ts:65-81`) plus the CORS allowlist
  (`app.ts:41-48`) already cover the browser-page attack path; keep it that way and consider an
  explicit host denylist (`localhost`, `127.0.0.0/8`, `169.254.169.254`, RFC1918) to avoid an
  SSRF-shaped foot-gun.

**Option B2 — the service worker fetches the URL.**
Possible, but costs three things. (i) Host permission: "To request access to remote servers outside
an extension's origin, add hosts, match patterns, or both to the `host_permissions` section"
([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).
For URLs known only at runtime the documented path is `optional_host_permissions: ["https://*/*"]`
plus `chrome.permissions.request()`, and "Permissions must be requested from inside a user gesture,
like a button's click handler"
([permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)) — the
panel's "Extract" button qualifies. (ii) No DOM: "Service workers don't have DOM access"
([offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)), so HTML→text
needs an offscreen document with reason `DOM_PARSER` or `DOM_SCRAPING` (both documented reasons,
same page) and the `offscreen` permission. (iii) Lifetime: Chrome terminates a service worker "When
a `fetch()` response takes more than 30 seconds to arrive"
([service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
A `https://*/*` permission prompt is also the single scariest string Chrome shows a user.

**Option B3 — open the URL in a background tab and let the content script read it.**
`chrome.tabs.create({ url, active: false })` then `SCAN_PAGE`/a new `READ_POSTING`. This is the only
option that carries the user's session, so it's the only one that can read a gated posting. It is
also the heaviest: a visible tab churn, a race against client-rendered postings, and it re-opens the
page-scraping decision. Note that content scripts cannot be used to dodge CORS: "Content scripts
initiate requests on behalf of the web origin that the content script has been injected into and
therefore content scripts are also subject to the same origin policy… cross-origin requests are
always treated as such in content scripts, even if the extension has host permissions"
([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).

**Recommendation:** ship B1, and make its failure mode a _first-class panel state_ — "couldn't read
that URL (it looks like a login page); paste the description instead" — with the paste box right
there. Keep B3 in reserve as an explicit "open it in a tab and read it" button if gated postings turn
out to dominate. Do not ship B2: it buys nothing B1 doesn't, at the cost of the broadest permission
in the manifest.

### 5.4 Input source (c): LinkedIn Easy Apply on-page

This one is different in kind: the questions are **real and present**, so nothing needs predicting.

- **Content script:** already injected on `https://*/*` with `all_frames: true`
  (`manifest.ts:36-47`) and already answers `SCAN_PAGE` with `detectFields(document)`
  (`content/index.ts:81-87`). The Easy Apply modal is a DOM dialog in the top frame; the existing
  scan should see it. `content/detect.ts:23`'s heuristic will likely _not_ auto-qualify the page
  before the modal opens (LinkedIn's job page has no file input and no resume-labelled control until
  then) — but that doesn't matter, because `SCAN_PAGE` is deliberately **not** gated on the heuristic
  (`content/index.ts:77-82`).
- **New:** a `READ_POSTING` request/response message alongside `SCAN_PAGE` in
  `ContentCommandMessage` (`messages.ts:102`), returning the posting text from the page. This is a
  deliberate, scoped exception to "the Job Description is pasted, never scraped" — the reason that
  rule exists ("the application form is usually a different page from the ad", `PROGRESS.md`) is
  precisely what is _not_ true on LinkedIn. Record it as such rather than as a reversal.
- **Multi-step modal:** Easy Apply is a wizard — contact info, resume, screening questions,
  work-authorization, review — rendered a step at a time. A single `SCAN_PAGE` sees one step. Either
  re-scan on each step (the content script's existing `MutationObserver` + settle already
  re-reports, `content/detect.ts:82-88`) and accumulate, or scan-on-demand from a panel button. The
  accumulate-across-steps model is new state that doesn't exist today.
- **No writes.** See §6. Recommendation is read-and-copy-out only, matching Phase 9's already-stated
  "Copy-out, not auto-fill" decision.

### 5.5 Where each piece lives

| Piece                                               | Home                                                                 | Note                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Mode tabs, source picker, kit display, copy buttons | `panel/App.tsx` + new `panel/ExtractTab.tsx`                         | Tab shell above `.panel-body` (`App.tsx:228`)                          |
| `START_EXTRACTION` dispatch                         | `lib/messages.ts` `TypedMessage` union (`messages.ts:122`)           | Notification-only, same rationale (`messages.ts:104-121`)              |
| Extraction run                                      | new `background/extractionPipeline.ts`                               | Survives panel close, same as `applicationPipeline.ts`                 |
| Extraction run state                                | new `chrome.storage.session` key — **not** `tab:${id}`               | See §5.6                                                               |
| `READ_POSTING` handler                              | `content/index.ts` (next to `SCAN_PAGE`)                             | Request/response, so it belongs in `pageClient.ts`, not `TypedMessage` |
| URL fetch + boilerplate strip                       | `apps/backend/src/routes/fetch-posting.ts`                           | No LLM                                                                 |
| Kit composition (model call)                        | `apps/backend/src/llm/applicationKit.ts`                             | `MODELS.writing`, reuse `answerQuestions`' prompt scaffold             |
| Wire bodies + kit schema                            | `packages/shared/src/wire.ts`, `schemas.ts`                          | One schema per body — non-negotiable (`wire.ts:1-16`)                  |
| Typed client methods                                | `lib/backendClient.ts:36` (`BackendClient`) + `httpBackendClient:56` | `satisfies` against the wire schemas                                   |

### 5.6 Storage: the run is not tab-scoped

`tabStore.ts:146` keys everything `` `tab:${tabId}` ``, and `registerTabStateCleanup`
(`tabStore.ts:333`) drops it on `tabs.onRemoved`. An extraction started from a pasted URL has no
meaningful tab, and one started on a LinkedIn tab shouldn't collide with an Application Pipeline run
if the candidate later opens the real ATS form in the same tab.

**Proposal:** a sibling module `lib/extractStore.ts` over `chrome.storage.session` with its own key
(`extract:current`, or `extract:${runId}` if history is wanted), holding:

```ts
type ExtractStatus = 'idle' | 'fetching' | 'extracting' | 'ready' | 'error';

interface ExtractionRunState {
  status: ExtractStatus;
  source: { kind: 'text' } | { kind: 'url'; url: string } | { kind: 'page'; tabId: number };
  jobDescription: string; // what was actually analyzed, after fetch/read
  kit: ApplicationKit | null;
  failure: { step: 'fetch' | 'extract'; message: string } | null;
}
```

Deliberately **not** reusing `PipelineStatus`: `runReview.ts`'s exhaustive `switch`
(`runReview.ts:77-114`) is a feature, and adding non-pipeline members to that union would force
every existing branch to grow an arm. Two small unions beat one union with a mode flag.

The `withTabLock` read-modify-write serialization (`tabStore.ts:212`) should be copied, for the same
reason it exists there.

### 5.7 New backend endpoints and output schema

**`POST /fetch-posting`** — no LLM.

```ts
// packages/shared/src/wire.ts
export const FetchPostingRequestSchema = z.object({ url: z.string().url() });
export const FetchPostingResponseSchema = z.object({
  jobDescription: z.string(),
  finalUrl: z.string(),
  title: z.string().nullable(),
  /** True when the fetched document looks like a login/consent wall rather than a posting. */
  gated: z.boolean(),
});
```

**`POST /application-kit`** — one model call, `MODELS.writing`.

```ts
export const ApplicationKitRequestSchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
  /** Real questions read off a page (Easy Apply). Empty when there's no form to read. */
  questions: z.array(QuestionForModelSchema).default([]),
  /** Ask the model to predict the likely question set when `questions` is empty. */
  predictQuestions: z.boolean().default(false),
});
```

Output — new in `packages/shared/src/schemas.ts`:

```ts
export const KitFieldSchema = z.object({
  category: FieldCategorySchema, // reuses detectedField.ts:30
  label: z.string(),
  value: z.string(),
  source: z.enum(['profile', 'prepared', 'drafted', 'predicted']),
});

export const ApplicationKitSchema = z.object({
  jobInfo: JobInfoSchema,
  /** Name/email/phone/location/links — from valueForCategory, no model call. */
  identity: z.array(KitFieldSchema),
  /** Screening facts answered verbatim from the Profile. */
  prepared: z.array(KitFieldSchema),
  /** Freeform answers the model drafted, grounded in the Profile. */
  drafted: z.array(QuestionAnswerSchema),
  /** Questions this employer is likely to ask, when no form was readable. */
  predicted: z.array(PendingQuestionSchema).default([]),
  /** Things the application will ask that the Profile cannot answer. */
  gaps: z.array(z.object({ question: z.string(), why: z.string() })).default([]),
  tailoredResume: TailoredResumeSchema.nullable().default(null),
});
```

**The one shared-types collision to decide up front:** `QuestionAnswerSchema.fieldId` is required and
documented as "Matches DetectedField.id" (`schemas.ts:195`), and `matchAnswerToField`
(`detectedField.ts`) depends on that identity to get an answer back onto a field
(`applicationPipeline.ts:189`). A _predicted_ question has no field. Two ways out:

- make `fieldId` `.nullable()` and audit every read — `applicationPipeline.ts:126-131`,
  `answerQuestions.ts:32` (`optionsByFieldId`), `fillForm.ts`; or
- keep `fieldId` required and mint synthetic ids (`predicted:0`, …) for predicted questions.

The second is smaller and preserves the invariant `detectedField.ts:11-21` is built around, at the
cost of an id that resolves to nothing. Prefer it, and say so in the doc comment.

### 5.8 Model routing

`extractJob` is Haiku (`llm/extractJob.ts:21`, `MODELS.extraction`); drafting is Sonnet
(`answerQuestions.ts:62`, `MODELS.writing`). Keep the split: posting → `JobInfo` is extraction;
question prediction and answer drafting are writing. `PROGRESS.md`'s open cleanup — "`tailorResume.ts`
/ `answerQuestions.ts` both hand-build the same `<base_profile>`/`<job_info>` prompt scaffold —
extract a shared helper if a third writing-model call site appears" — is triggered by this work.
Extract the helper here rather than writing a third copy.

---

## 6. Constraints & risks

### 6.1 LinkedIn — the facts, neutrally

LinkedIn's own documents are unambiguous, and all three say the same thing:

- **User Agreement §8.2 ("Don'ts")** prohibits members from: _"Develop, support or use software,
  devices, scripts, robots or any other means or processes (such as crawlers, browser plugins and
  add-ons or any other technology) to scrape or copy the Services, including profiles and other data
  from the Services"_; and _"Use bots or other unauthorized automated methods to access the
  Services, add or download contacts, send or redirect messages, create, comment on, like, share, or
  re-share posts, or otherwise drive inauthentic engagement"_; and _"Override any security feature or
  bypass or circumvent any access controls or use limits of the Services."_
  ([linkedin.com/legal/user-agreement](https://www.linkedin.com/legal/user-agreement))
- **LinkedIn's prohibited-software help page** states LinkedIn does not permit _"third party
  software, including 'crawlers', bots, browser plug-ins, or browser extensions that scrape, modify
  the appearance of, or automate activity on LinkedIn's website"_, and that members who use them
  _"risk having their accounts restricted or shut down"_, while the tools themselves _"may become
  non-operational without notice."_
  ([linkedin.com/help/linkedin/answer/a1341387](https://www.linkedin.com/help/linkedin/answer/a1341387))
- **`linkedin.com/robots.txt`** opens with _"The use of robots or other automated means to access
  LinkedIn without the express permission of LinkedIn is strictly prohibited"_, and terminates with a
  blanket `User-agent: * / Disallow: /`. `/job-apply/`, `/jobs/view/externalApply/` and
  `/api/jobPostings/jobs*` are explicitly disallowed for every named crawler.
  ([linkedin.com/robots.txt](https://www.linkedin.com/robots.txt))

**What that implies for each option, factually:**

| Behaviour                                                                                                                      | Standing under LinkedIn's own terms                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend fetches a `linkedin.com` URL server-side                                                                               | Squarely the robots.txt + §8.2 scraping case. Also won't work — logged-out job pages hit an auth wall.                                                                                                                                                                   |
| Content script **writes** into the Easy Apply modal                                                                            | "automate activity on LinkedIn's website" — the clearest violation, and the one with account-restriction risk.                                                                                                                                                           |
| Content script **reads** the open modal the user is already looking at, extension shows the answers for the user to type/paste | Still literally within §8.2's "browser plugins and add-ons… to scrape or copy the Services". Lower practical exposure (no server-side crawl, no automated action, nothing leaves the user's machine except to their own localhost backend), but not _outside_ the terms. |
| User pastes the JD text themselves; extension never touches linkedin.com                                                       | Outside LinkedIn's terms entirely.                                                                                                                                                                                                                                       |

The enforcement mechanism is account-level (restriction/shutdown), and it falls on **the user's
LinkedIn account**, not on the extension. That is the fact worth surfacing in the UI regardless of
which option is chosen.

**Recommendation:** for the LinkedIn source, ship read-and-copy-out only, never a write; never fetch
linkedin.com from the backend; and offer paste as the always-available fallback. This also aligns
with the already-recorded Phase 9 decision ("Copy-out, not auto-fill… this phase adds no new path
from a drafted answer into a form field").

### 6.2 Chrome Web Store policy

Two policies bear on a second mode, neither of which blocks it:

- **Single purpose:** _"An extension must have a single purpose that is narrow and easy to
  understand. Don't create an extension that requires users to accept bundles of unrelated
  functionality."_
  ([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines))
  Extraction mode is the same purpose as autofill — helping a candidate complete a job application —
  so this is satisfied, but the store listing should describe it as one purpose with two workflows,
  not as two features.
- **Misleading / unexpected behavior:** _"Don't misrepresent the functionality of your product or
  include non-obvious functionality that doesn't serve the primary purpose"_; _"Descriptions of your
  product must directly state the functionality so that users have a clear understanding of the
  product they are adding."_
  ([unexpected behavior](https://developer.chrome.com/docs/webstore/program-policies/unexpected-behavior))
  Reading a page the user has open, on their instruction, is disclosable and fine; doing it silently
  is not.

The store policies do **not**, on their own pages, ban automating a third-party site or require
third-party-ToS compliance — I looked and found no such clause on the program-policies index,
quality-guidelines or unexpected-behavior pages. The LinkedIn constraint above is a contract-with-
LinkedIn constraint, not a Chrome Web Store one.

### 6.3 Host permissions & CORS

- Extension pages and the service worker can talk cross-origin _given host permissions_: _"A script
  executing in an extension service worker or foreground tab can talk to remote servers outside of
  its origin, as long as the extension requests host permissions"_
  ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)).
  This is why `callBackend.ts:16` can `fetch('http://127.0.0.1:5391')` from both the panel and the
  worker — `manifest.ts:49` grants it extension-wide.
- Content scripts cannot: _"cross-origin requests are always treated as such in content scripts, even
  if the extension has host permissions"_ (same page). So "inject a script into linkedin.com and have
  it fetch the posting JSON" is not a CORS work-around.
- Runtime-discovered hosts need `optional_host_permissions` and a gesture-scoped
  `chrome.permissions.request()`
  ([permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)). Adding
  `https://*/*` there is the loudest possible permission string; §5.3 recommends avoiding it.
- `Tab.url` is available today only because `manifest.ts:59` includes `tabs`: _"This property is only
  present if the extension has the 'tabs' permission or has host permissions for the page"_
  ([tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)).

### 6.4 MV3 constraints already in play here

- **Service-worker lifetime.** Chrome terminates it _"After 30 seconds of inactivity"_, _"When a
  single request, such as an event or API call, takes longer than 5 minutes to process"_, and _"When
  a `fetch()` response takes more than 30 seconds to arrive"_
  ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
  The existing pipeline already lives with this: `analysisStep` awaits a Sonnet `tailorResume` from
  the local backend (`applicationPipeline.ts:111-114`), and a slow model call is a real 30-second-
  fetch exposure. Extraction mode inherits it. Two mitigations worth considering: keep each backend
  round trip to one model call, and have the backend answer fast with a run id if streaming is ever
  added. The checkpoint-into-storage design (`applicationPipeline.ts:1-17`) is what makes a
  termination survivable today — keep it.
- **No DOM in the worker.** _"Service workers don't have DOM access"_
  ([offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)) — hence §5.3's
  preference for parsing HTML on the backend.
- **Content script version skew.** `tabStore.ts:150-165` re-parses every stored Detected Field
  because `chrome.storage.session` outlives an extension reload; `content/index.ts:34-58` handles the
  orphaned-content-script case explicitly. Any new content message (`READ_POSTING`) must obey both.

### 6.5 Product risks

- **Silent omission.** Commit `acc42da` is the precedent: five classification defects that each
  failed invisibly. An extraction that quietly drops a question the form asks is indistinguishable
  from a form that doesn't ask it. The kit should report `gaps` explicitly (§5.7) and say how many
  questions it read vs. predicted.
- **Predicted questions are speculation.** They must be visually distinguished from questions
  actually read off a page, or the user will paste an answer to a question nobody asked.
- **Duplicate guard.** `findDuplicate` (`applicationPipeline.ts:323`) keys on `tabUrl`. An extraction
  from a pasted URL has a URL and could use it; one from pasted text has nothing to key on. Decide
  whether the guard runs in this mode at all — it fails open by design, so "doesn't run" is a
  defensible default.
- **Cover letters.** `cover_letter_text` / `cover_letter_upload` are detected but deliberately not
  filled (`PROGRESS.md` "Constraints that look like mistakes"). A "prepare everything" mode is
  exactly where a user will expect a cover letter. That's a scope expansion, not a free reuse.

---

## 7. Open questions for the user

1. **What is the artifact?** Values-only for copy-out (§1 interpretation (i)), today's pipeline
   stopping short of Fill (ii), or a recon report about the employer (iii)? This decides whether a
   Tailored Resume and a PDF are still produced, and whether §4's recommendation (tab) even holds —
   under (ii) alone, a toggle wins.
2. **Does extraction mode ever write to a page?** Recommendation is no (copy-out only), which keeps
   LinkedIn read-only and matches the Phase 9 decision. Confirm — if it _should_ fill non-LinkedIn
   forms, then it isn't a second mode, it's the existing pipeline with a different front end.
3. **LinkedIn posture.** Accept read-and-copy-out with an in-UI note about LinkedIn's terms
   (§6.1), or stay entirely off linkedin.com and treat "LinkedIn" as "paste the text"? The middle
   ground of auto-filling the Easy Apply modal is the one option that squarely conflicts with
   LinkedIn's own terms and risks the user's account.
4. **Is an extraction run tab-scoped or global?** §5.6 proposes a separate storage key, which means
   one extraction at a time across the browser. Alternative: a per-run id with a short history list.
   Which matches how you'd actually use it — one at a time, or a queue of postings?
5. **Should extraction runs be saved as Applications?** They'd have Job Info but no fill and possibly
   no `jobUrl` — and `ApplicationSchema` (`schemas.ts:282`) requires `tailoredResume`. Saving them
   would also make them count for the duplicate guard, which may or may not be wanted.
6. **URL fetching: backend or browser?** §5.3 recommends the backend (B1) and accepts that gated
   postings fail. Is "open it in a background tab and read it" (B3) worth building as the fallback,
   or is "paste the text instead" acceptable?
7. **`QuestionAnswer.fieldId` for predicted questions** — synthetic ids (recommended) or make the
   field nullable? This one is a shared-schema change either way and should be settled before code.
8. **Phase 9 overlap.** `PROGRESS.md` Phase 9 plans an "Ask" tab with a `POST /answer-chat` route,
   drafting from the Profile with an optional `jobInfo`. That is a strict subset of
   `POST /application-kit`. Should Phase 9 be folded into this work — one route, one tab with a
   sub-mode — rather than shipped separately? The comparable collision inside Phase 9 (a cold ask vs.
   refining an existing draft) was settled by merging: one chat UI, one route, seeded differently.

---

## Sources

Repo (all paths relative to the repo root, line numbers as of `36e3d90`):
`AGENTS.md`, `CONTEXT.md`, `PROGRESS.md`, `README.md`, `docs/ats-platform-detection.md`,
`docs/agents/domain.md`, `apps/extension/src/manifest.ts`,
`apps/extension/src/background/{service-worker,router,applicationPipeline,apiDetectors}.ts`,
`apps/extension/src/content/{index,detect,detectFields,fillForm}.ts`,
`apps/extension/src/lib/{messages,pageClient,tabStore,runReview,callBackend,backendClient}.ts`,
`apps/extension/src/panel/{App.tsx,useActiveTab.ts,usePipelineRun.ts}`,
`apps/backend/src/{app.ts,routes/*,llm/*}`, `packages/shared/src/{wire,schemas,detectedField,preparedAnswers,screeningAnswers}.ts`,
and commit `acc42da` ("Fix five silent failures behind Greenhouse autofill").

External (primary only):

- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.chrome.com/docs/extensions/reference/api/scripting
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/webstore/program-policies
- https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines
- https://developer.chrome.com/docs/webstore/program-policies/unexpected-behavior
- https://www.linkedin.com/legal/user-agreement
- https://www.linkedin.com/help/linkedin/answer/a1341387
- https://www.linkedin.com/robots.txt
