# `packages/`

Workspace packages shared by the three apps. Each package has its own `src/index.ts` as its public
surface; `@djobi/shared` has its own detailed README.

## Shared packages and who imports them

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
flowchart TB
  ext("apps/extension")
  dash("apps/dashboard")
  backend("apps/backend")

  http("@djobi/http-client<br/>createHttpTransport: json · binary · upload<br/>HttpError kinds: http · timeout · network · invalid-response<br/>90s default deadline · isUnauthorized · userMessage")
  editor("@djobi/profile-editor (React)<br/>useProfileDraft · useProfileWorkflow<br/>section inventory + section/field components<br/>list + bullet editing (★ starred bullets)")
  manualLog("@djobi/manual-log (React)<br/>useManualLogFlow<br/>extract + duplicate check → review → save")
  shared("@djobi/shared (zod)<br/>schemas · wire · detectedField<br/>jobKey · duplicateGuard · applicationPayload<br/>keywordCoverage · requirementEvidence · requirementImportance<br/>labelMatching · screeningAnswers · preparedAnswers<br/>bulletProvenance · httpUrl · resumeFileName · failureMessage")

  ext --> http & editor & manualLog & shared
  dash --> http & editor & manualLog & shared
  backend --> shared
  editor --> http & shared
  manualLog --> http & shared
  http --> shared

  classDef page fill:#ffedd5,stroke:#f97316,stroke-width:1.5px,color:#7c2d12
  classDef worker fill:#fce7f3,stroke:#ec4899,stroke-width:1.5px,color:#831843
  classDef ui fill:#ede9fe,stroke:#8b5cf6,stroke-width:1.5px,color:#4c1d95
  classDef http fill:#e0f2fe,stroke:#0ea5e9,stroke-width:1.5px,color:#0c4a6e
  classDef data fill:#d1fae5,stroke:#10b981,stroke-width:1.5px,color:#064e3b
  classDef external fill:#fef3c7,stroke:#f59e0b,stroke-width:1.5px,color:#78350f
  classDef entry fill:#e0e7ff,stroke:#6366f1,stroke-width:1.5px,color:#312e81
  classDef danger fill:#ffe4e6,stroke:#f43f5e,stroke-width:1.5px,color:#881337
  class ext,dash,backend entry
  class http http
  class editor ui
  class manualLog worker
  class shared data

  linkStyle default stroke:#94a3b8,stroke-width:1.5px
```

| Package                 | Imported by                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@djobi/http-client`    | extension `lib/callBackend.ts`, `lib/authClient.ts`, `options/Login.tsx`, `panel/useAskThread.ts`; dashboard `lib/dashboardClient.ts`, `lib/useApplicationStore.ts`, `lib/dashboardSession.ts`, `views/{Login,SignUp,Profile,NewApplication}.tsx`; `profile-editor`, `manual-log` |
| `@djobi/profile-editor` | extension `options/App.tsx`; dashboard `views/Profile.tsx`                                                                                                                                                                                                                        |
| `@djobi/manual-log`     | extension `panel/LogApplication.tsx`; dashboard `views/NewApplication.tsx`                                                                                                                                                                                                        |
| `@djobi/shared`         | all three apps, and the other three packages                                                                                                                                                                                                                                      |

`@djobi/shared` is the contract all three apps must agree on. `http-client` is client
infrastructure and is kept out of `shared` on purpose. `profile-editor` and `manual-log` hold
behavior shared by the two frontends: `profile-editor` also ships the section and field components
both Profile editors render, while `manual-log` is a hook only, and each app keeps its own form
markup and error policy.

### Where to start reading

- Domain terms: `CONTEXT.md`. Deploy direction: `docs/adr/0001-cloudflare-single-worker.md` and
  `docs/adr/0002-postgres-driver-for-local-dev.md`. Auth phases: `docs/multi-tenant-auth.md`.
- Backend wiring: `apps/backend/src/app.ts` → `routes/llm.ts` → `llm/structuredCall.ts`.
- Extension core: `background/applicationPipeline.ts`, `background/runClaim.ts`,
  `lib/run/status.ts`, `lib/messages.ts`.
- Page interaction: `content/detectFields.ts`, `content/fillForm.ts`,
  `background/apiDetectors.ts`.
- Dashboard state: `apps/dashboard/src/lib/useApplicationStore.ts`, `useHashRoute.ts`.
