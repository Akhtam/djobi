# `apps/extension`

MV3 · Vite + crxjs + React

## Chrome extension internals

There are four execution contexts, and each owns something specific. Content scripts own the DOM.
The service worker owns every step that costs money or can't be undone. The panel owns the
candidate's optimistic edits. `chrome.storage.session` is where they all meet.

```mermaid
---
config:
  theme: base
  themeVariables:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    primaryColor: "#f1f5f9"
    primaryBorderColor: "#94a3b8"
    primaryTextColor: "#0f172a"
    textColor: "#334155"
    lineColor: "#94a3b8"
    edgeLabelBackground: "#f8fafc"
    clusterBkg: "#f8fafc"
    clusterBorder: "#cbd5e1"
    titleColor: "#64748b"
  flowchart:
    curve: basis
    padding: 18
    nodeSpacing: 36
    rankSpacing: 56
---
flowchart LR
  subgraph content["Content script · content/"]
    cIndex("index.ts<br/>message handler + watcher")
    detect("detect.ts<br/>file input / resume|cv|cover letter|linkedin label")
    detectFields("detectFields.ts<br/>→ DetectedField[] (category)")
    signals("pageSignals.ts · detectedFieldDom.ts<br/>realm-safe label ladder · field ↔ live DOM")
    extractJd("extractJobDescription.ts<br/>JSON-LD JobPosting → DOM score")
    fill("fillForm.ts<br/>native setter + InputEvent")
    submit("submitWatch.ts<br/>armed only after a fill")
    toast("savedToast.ts<br/>on-page confirmation")
  end

  subgraph worker["Service worker · background/"]
    sw("service-worker.ts<br/>envelope parse · recoveryReady<br/>tab cleanup · side-panel behavior")
    router("router.ts<br/>handleTypedMessage switch<br/>withWorkerKeptAlive")
    pipeline("applicationPipeline.ts<br/>runAnalysis · runFill<br/>runSaveApplication")
    claim("runClaim.ts<br/>lock + abort")
    failure("pipelineFailure.ts<br/>failure → run vocabulary")
    detected("detectedFields.ts + apiDetectors.ts<br/>recordReport · snapshotForRun · frameForFill<br/>enrichWithApiOracle")
    badge("saveBadge.ts<br/>toolbar ✓")
  end

  subgraph lib["Shared lib · lib/"]
    tabStore[("tabStore/<br/>record.ts (tab lock)<br/>pipelineRun.ts · detectedPage.ts<br/>jobContext.ts<br/>lifecycle.ts (tab close / navigation)")]
    run("run/<br/>status.ts FACTS table · state.ts<br/>review · answers<br/>canFill/canSave/…")
    pageClient("pageClient.ts<br/>tabs.sendMessage · notifyPage")
    keepAlive("keepAlive.ts<br/>getPlatformInfo (20s beat)")
    disposition("fieldDisposition.ts<br/>category → fill / answer / attach / skip")
    backendClient("backendClient.ts<br/>schema.parse projections<br/>→ callBackend transport (@djobi/http-client)")
    auth("authClient · authToken<br/>sharedSessionCookie")
    messages("messages.ts<br/>zod envelope djobi/typed-message v1")
  end

  subgraph ui["UI · panel/ options/"]
    panelApp("panel/App<br/>profile bootstrap · tab switch")
    autofill("AutofillTab")
    logTab("LogApplication")
    ask("AskTab")
    hooks("hooks<br/>usePipelineRun · useActiveRun · useActiveTab<br/>useJobDescription · useAskThread · useResumePreview<br/>pipelineCommands")
    options("options/App<br/>Profile editor · Login · resume upload")
  end

  cIndex -- "REPORT_JOB_PAGE · REPORT_SUBMISSION" --> sw
  sw --> router --> pipeline
  pipeline --> claim
  pipeline -- "checkpoint" --> tabStore
  pipeline -. "SCAN_PAGE · FILL_FORM · SHOW_SAVED_TOAST" .-> pageClient
  pageClient -.-> cIndex
  tabStore -. "onChanged" .-> hooks
  hooks -- "notify(START_ANALYSIS · UPDATE_JOB_CONTEXT · CHECK_RUN)<br/>START_FILL · START_SAVE_APPLICATION · UPDATE_RUN (reply)" --> sw
  hooks -. "SCRAPE_JOB_DESCRIPTION" .-> pageClient
  pipeline -- "backend" --> backendClient
  panelApp -- "getProfile" --> backendClient
  logTab -- "extractJob · duplicates · saveApplication" --> backendClient
  ask -- "answerChat" --> backendClient
  hooks -- "renderResumePdf" --> backendClient
  options -- "profile · extractResume · signIn/Out" --> backendClient
  backendClient --> auth

  classDef page fill:#ffedd5,stroke:#f97316,stroke-width:1.5px,color:#7c2d12
  classDef worker fill:#fce7f3,stroke:#ec4899,stroke-width:1.5px,color:#831843
  classDef ui fill:#ede9fe,stroke:#8b5cf6,stroke-width:1.5px,color:#4c1d95
  classDef http fill:#e0f2fe,stroke:#0ea5e9,stroke-width:1.5px,color:#0c4a6e
  classDef data fill:#d1fae5,stroke:#10b981,stroke-width:1.5px,color:#064e3b
  classDef external fill:#fef3c7,stroke:#f59e0b,stroke-width:1.5px,color:#78350f
  classDef entry fill:#e0e7ff,stroke:#6366f1,stroke-width:1.5px,color:#312e81
  classDef danger fill:#ffe4e6,stroke:#f43f5e,stroke-width:1.5px,color:#881337
  class cIndex,detect,detectFields,signals,extractJd,fill,submit,toast page
  class sw,router,pipeline,claim,failure,detected,badge worker
  class tabStore,run,pageClient,keepAlive,disposition,messages data
  class backendClient,auth http
  class panelApp,autofill,logTab,ask,hooks,options ui

  style content fill:#f973160f,stroke:#f97316,stroke-width:1.5px,color:#f97316
  style worker fill:#ec48990f,stroke:#ec4899,stroke-width:1.5px,color:#ec4899
  style lib fill:#10b9810f,stroke:#10b981,stroke-width:1.5px,color:#10b981
  style ui fill:#8b5cf60f,stroke:#8b5cf6,stroke-width:1.5px,color:#8b5cf6

  linkStyle default stroke:#94a3b8,stroke-width:1.5px
```

Messages go one way on each channel. Panel and content script send typed messages _to_ the worker
(`lib/messages.ts`, validated against the envelope). Request/response commands go _to_ content
scripts through `lib/pageClient.ts`: from the worker (`SCAN_PAGE`, `FILL_FORM`, and the
fire-and-forget `SHOW_SAVED_TOAST`), and from the panel for `SCRAPE_JOB_DESCRIPTION`. Only
`UPDATE_RUN`, `START_FILL` and `START_SAVE_APPLICATION` reply to the panel, because a refusal writes
nothing to storage that the panel could observe. Every backend call, whether from the worker, the
panel or the options page, goes through `lib/backendClient.ts` — except sign-in and sign-out, which
`lib/authClient.ts` sends with a raw `fetch` because it needs Better Auth's `set-auth-token`
response header.

### Message protocol (`djobi/typed-message` v1)

| Message                   | From → To        | Reply                            | Effect                                                                               |
| ------------------------- | ---------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `REPORT_JOB_PAGE`         | content → worker | ack                              | `recordReport` per (tab, frame); enrich via ATS oracle using the sending frame's URL |
| `START_ANALYSIS`          | panel → worker   | ack                              | clear badge; `runAnalysis` (duplicate guard → `/analyze`; `force` skips the guard)   |
| `START_FILL`              | panel → worker   | `ClaimResult`                    | `runFill` with `expectedRunId`                                                       |
| `START_SAVE_APPLICATION`  | panel → worker   | `ClaimResult`                    | `runSaveApplication` with `expectedRunId` (cancellation: none)                       |
| `UPDATE_RUN`              | panel → worker   | `{applied}`                      | `applyPanelEdit` under tab lock; saved → filled if changed                           |
| `UPDATE_JOB_CONTEXT`      | panel → worker   | ack                              | keep pasted JD across same-job routes                                                |
| `REPORT_SUBMISSION`       | content → worker | ack                              | auto Save Step for that `runId` (same claim; refuses a superseded run)               |
| `CHECK_RUN`               | panel → worker   | ack                              | no-op; wakes worker so recovery sweep runs (every 15s)                               |
| `SCAN_PAGE` / `FILL_FORM` | worker → content | `JobPageData` / `FillFormResult` | fresh scan; write values, attach resume bytes                                        |
| `SCRAPE_JOB_DESCRIPTION`  | panel → content  | `{candidate}` per frame          | best-scoring frame fills the editable JD field (fails closed)                        |
| `SHOW_SAVED_TOAST`        | worker → content | —                                | best-effort on-page toast                                                            |

## Application Pipeline — run state machine

Each tab has at most one **run**, stored in `chrome.storage.session`. The run goes through three
steps: **Analysis → Fill → Save**. Every step follows the same shape: a _running_ status, then a
_succeeded_ or _failed_ one (`STEP_STATUS` in `lib/run/status.ts`).

```mermaid
---
config:
  theme: base
  themeVariables:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    primaryColor: "#f1f5f9"
    primaryBorderColor: "#94a3b8"
    primaryTextColor: "#0f172a"
    textColor: "#334155"
    lineColor: "#94a3b8"
    edgeLabelBackground: "#f8fafc"
    clusterBkg: "#f8fafc"
    clusterBorder: "#cbd5e1"
    titleColor: "#64748b"
  flowchart:
    curve: basis
    padding: 18
    nodeSpacing: 36
    rankSpacing: 56
---
flowchart LR
  start((no run))

  analyzing([analyzing])
  review(review)
  filling([filling])
  filled(filled)
  saving([saving])
  saved(saved)

  duplicate(duplicate)
  analyzeError(analyze-error)
  fillError(fill-error)
  saveError(save-error)

  %% Happy path
  start -- Analyze --> analyzing
  analyzing == ok ==> review
  review == Fill ==> filling
  filling == ok ==> filled
  filled == Save ==> saving
  saving == ok ==> saved

  %% Side exits
  analyzing -- already applied --> duplicate
  analyzing -- failed --> analyzeError
  filling -- failed --> fillError
  saving -- failed --> saveError

  %% Ways back
  duplicate -. Apply anyway .-> analyzing
  fillError -. retry .-> filling
  saveError -. retry .-> saving
  saved -. answer edited .-> filled

  classDef idle fill:#f1f5f9,stroke:#64748b,stroke-width:1.5px,color:#0f172a
  classDef busy fill:#e0f2fe,stroke:#0ea5e9,stroke-width:2px,color:#0c4a6e
  classDef done fill:#d1fae5,stroke:#10b981,stroke-width:2px,color:#064e3b
  classDef warn fill:#fef3c7,stroke:#f59e0b,stroke-width:1.5px,color:#78350f
  classDef error fill:#ffe4e6,stroke:#f43f5e,stroke-width:1.5px,color:#881337
  classDef origin fill:#fce7f3,stroke:#ec4899,stroke-width:2px,color:#831843

  class start origin
  class review,filled idle
  class analyzing,filling,saving busy
  class saved done
  class duplicate warn
  class analyzeError,fillError,saveError error

  linkStyle 0 stroke:#ec4899,stroke-width:2px
  linkStyle 1,2,3,4,5 stroke:#10b981,stroke-width:3px
  linkStyle 6 stroke:#f59e0b,stroke-width:1.5px
  linkStyle 7,8,9 stroke:#f43f5e,stroke-width:1.5px
  linkStyle 10,11,12,13 stroke:#94a3b8,stroke-width:1.5px
```

**How to read it:** thick arrows are the happy path. Blue pills mean a step is running, green is
done, amber means the run stopped on purpose, red means it failed. Dotted arrows go back.

Two things aren't drawn, to keep the diagram readable: **Analyze** can restart from _any_ status,
and **Fill** can also re-run from `filled`, `save-error` or `saved`. The table has the full rules.

| Step         | Starts from                                                 | Running     | Succeeded                 | Failed          |
| ------------ | ----------------------------------------------------------- | ----------- | ------------------------- | --------------- |
| **Analysis** | any status, or no run                                       | `analyzing` | `review` (or `duplicate`) | `analyze-error` |
| **Fill**     | `review` · `fill-error` · `filled` · `save-error` · `saved` | `filling`   | `filled`                  | `fill-error`    |
| **Save**     | `filled` · `save-error`                                     | `saving`    | `saved`                   | `save-error`    |

### Rules

- **One table decides.** The "Starts from" column is derived from `FACTS` in `lib/run/status.ts`.
  Fill needs a reviewable run that isn't busy. Save needs a fill that isn't busy and hasn't been
  recorded yet. The panel's buttons and the worker's claims both read `canStart`, so they can't
  disagree.
- **Analysis replaces, Fill and Save transition.** Analysis mints a new `runId` and supersedes
  whatever the tab held. Fill and Save go through `withRunClaim` with `expectedRunId`. If the run
  was replaced or is busy, they refuse with `{ claimed: false, reason: 'stale-run' | 'busy' }`.
- **`duplicate` is not an error.** The run stops before any LLM call because this job URL already
  has a saved Application.
- **Edits** (`UPDATE_RUN`) are accepted in every status except `saving`. An edit that changes a
  `saved` run moves it back to `filled`, because the saved record no longer matches.
- **Recovery.** When a new worker starts, it moves any run left in `analyzing`, `filling` or
  `saving` to that step's `*-error` status (failure kind `temporary`). It does this before routing
  any message.
- **Failure kinds.** `pipelineFailure.ts` maps every error to one of
  `cancelled · invalid-page · invalid-model-output · unauthorized · backend-unreachable · temporary · unknown`.
- **Fill outcome.** Based on what the page reports it kept, a finished fill sets `fillOutcome` to
  `complete · incomplete · nothing-filled · unverified · no-fields-detected`.

### Analysis Step (`runAnalysis`)

- Seeds a fresh run (`mode: replace`, `cancellation: supersede`).
- Runs in parallel: `snapshotForRun` (waits for the oracle to finish enriching) and `findDuplicate`
  (`GET /applications?jobUrl&response=compact`, skipped when `force`).
- Duplicate found → stop. No LLM call is made.
- Splits questions: `splitPreparedQuestions` answers what the Profile already covers. Only
  _required_ or known-answer questions go to the model.
- `backend.analyzeApplication(jd, profile, toDraft, signal)`
- Merges answers back into page order, then computes `keywordCoverage` locally.

### Fill Step (`fillStep`)

- Starts rendering the PDF _early_ if the analyzed form had a resume field.
- `frameForFill` → `SCAN_PAGE` on that frame; falls back to a broadcast scan (the fill itself is
  never retried).
- `mergeRescan`: takes elements from the fresh scan and wording from the analyzed run.
- Picks each value via `autofillSource(category)` (`lib/fieldDisposition.ts`): question / profile /
  resume / unsupported.
- Checks `claim.stillOurs()` immediately before the irreversible `FILL_FORM`.
- Computes `unresolvedRequiredFields` and `filledFieldCount` from the page's response.

### Save Step (`runSaveApplication`)

- Can't be cancelled on purpose: aborting mid-request can't tell you whether the row was written.
- Fetches the Profile fresh (best-effort) → `autofillApplicationPayload`.
- No `applicationId` yet → `POST /applications` with `idempotency-key: runId`. Otherwise →
  `PATCH /applications/:id`.
- Announces the save: toolbar badge plus on-page toast.

### MV3 survival kit

- `keepAlive`: calls `getPlatformInfo` every 20s while a step is pending. A pending fetch alone
  doesn't count as activity.
- Every step checkpoints to session storage, so a closed panel loses nothing.
- `recoverInterruptedPipelineRuns` must finish before the worker routes any message.
- `lifecycle.ts`: closing the tab clears its record. Navigating drops the detected frames, and keeps
  the run and Job Context only if the new URL is the same posting.
