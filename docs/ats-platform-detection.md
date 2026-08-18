# ATS platform detection — research for generalizing field detection

> **Status: research current, strategy implemented (2026-08-12).** The per-platform sections below
> are live-verified primary evidence and still stand — that's what this doc is for. The
> "Detection strategy" section at the end has since been built; it now records what landed and
> where, rather than what to do.
>
> One correction to the framing below: the ATS **host allowlist described in this doc no longer
> exists**. `lib/atsHosts.ts` was deleted. `manifest.ts` now matches `http(s)://*/*` with
> `all_frames: true`, and whether a page is an application form is decided at runtime by the
> page-shape heuristic in `content/detect.ts` — because ATS platforms let companies white-label
> their job board onto their own domain, so a host list can never be complete. Where a section
> below says a platform is reached "via the allowlist", read: reached like any other page.

## Why this doc exists

It was written to diagnose a concrete bug (since fixed): on Greenhouse
(`job-boards.greenhouse.io`), `detectFields.ts` only queried `input, textarea, select`, so
Greenhouse's required screening questions — work authorization, sponsorship, "how did you hear
about us", location — were invisible to it entirely, because they render as **react-select
comboboxes** (`<input role="combobox">` inside `div.select__*` markup), not `<select>` elements.
Multi-choice questions use native `<fieldset>`/`<input type="checkbox">` groups, also unhandled at
the time.

Answering that question meant establishing, per platform, how the form is actually rendered, how
required-ness is signalled, how labels are associated, how file upload works, and whether a public
API exposes the form schema. **That evidence is what this doc is for, and it is what remains
useful** — it was gathered by live `curl` and real API calls, and re-acquiring it is expensive.

Platforms covered: Greenhouse, Lever, Workday, iCIMS, Ashby, SmartRecruiters, Workable, BambooHR —
the eight djobi was researched against.

---

## Greenhouse (`job-boards.greenhouse.io`)

**1. Rendering pattern.** Live `curl` of
`https://job-boards.greenhouse.io/greenhouse/jobs/8080711?gh_jid=8080711` (no JS execution)
returned 79,757 bytes of **server-rendered HTML containing the full form markup already
present** — one `<form id="application-form">`, 29 `<input>` elements, 22 `<label>` elements, all
before any client JS runs. Class names (`remix-css-13cymwt-control`, `data-emotion` attributes)
indicate a **Remix** app using **emotion** CSS-in-JS; there's also an empty
`<div id="react-portal-mount-point">` for interactive overlays (dropdown option lists render into
this on open, confirmed by 0 `<select>` tags but 9 `role="combobox"` inputs with
`aria-haspopup="true"` in the static markup — the option list itself is not in the initial HTML).
**Verified directly, not from docs.**

**2. Field widget patterns.** Zero native `<select>` elements (`grep -c '<select'` = 0). Custom
dropdowns are **react-select**: `<input role="combobox" aria-expanded aria-haspopup="true"
aria-labelledby="{id}-label" aria-controls>` inside `<div class="select__control ...">`
/`select__input-container`/`select__value-container`, with class prefix `select__` (react-select's
`classNamePrefix`) plus Remix/emotion hashed suffixes (`remix-css-<hash>-control`). 9 such
comboboxes on this one posting (country, location, work authorization, sponsorship, "how did you
hear about us", "point of data transfer", etc.). Checkbox groups use a real `<fieldset
class="checkbox" aria-required="true"><legend>...<span class="required">*</span></legend>`
wrapping native `<input type="checkbox" name="question_X[]">` — no radio groups seen on this
posting but the same fieldset/legend pattern is documented for Greenhouse's "multi-value single
select" rendered as radio-style choices. **Verified directly.**

**3. Required-field signaling.** Three redundant signals present simultaneously: `aria-required="true"`
on the input/combobox itself (16 `true` / 4 `false` on this page); a visually-hidden required
input (`<input required tabindex="-1" aria-hidden="true" class="...-requiredInput">`) used for
native HTML5 validation on react-select fields that have no real `required` attribute of their
own; and a visible `<span class="required">*</span>` inside the label/legend text. **Verified
directly.**

**4. Label association.** Standard fields (`first_name`, `email`, `phone`, `candidate-location`)
use proper `<label id="x-label" for="x">`. React-select comboboxes use `aria-labelledby="{id}-label"`
pointing at that same label element (not a native `for`/`id` pair on the visible input, since the
combobox's `id` belongs to the inner search `<input>`, not the answer). The résumé/cover-letter
file group's _visible_ label ("Resume/CV *") is a plain `<div id="upload-label-resume">` referenced
via `aria-labelledby` on an enclosing `<div role="group">`, while the actual `<input type="file">`
only has a separate `<label class="visually-hidden" for="resume">Attach</label>` — i.e. the
required-asterisk text a human reads is **not** the label formally bound to the input. **Verified
directly.**

**5. File upload mechanism.** Native `<input id="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"
class="visually-hidden">`, hidden and triggered by a styled `<button>`/`<label for="resume">`. No
`drag`/`drop`/`dragover` event hooks found in this posting's static markup (only false-positive
matches for "Dropbox" and "dropdown"). The existing `attachResumeFile` (`Object.defineProperty`
on `.files` + `change` event) should work as-is for Greenhouse's default embed. **Verified
directly** (for this specific instance; company-customized Greenhouse embeds could differ —
flagging as a caveat, not "needs live verification" since the mechanism itself is standard
Greenhouse markup).

**6. Public API.** **Preferred detection path exists.** Greenhouse's public Job Board API:
`GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true` — live
`curl`-verified against job 8080711/board `greenhouse`, HTTP 200, returned an 18-entry `questions`
array. Example entries:

```json
{"label": "First Name", "required": true, "fields": [{"name":"first_name","type":"input_text","values":[]}]}
{"label": "Resume/CV", "required": true, "fields": [
  {"name":"resume","type":"input_file","values":[]},
  {"name":"resume_text","type":"textarea","values":[]}
]}
```

`type` values include `input_text`, `input_file`, `textarea`, and (per
[developers.greenhouse.io/job-board.html](https://developers.greenhouse.io/job-board.html))
`multi_value_single_select` / `multi_value_multi_select` with a `values: [{value, label}]` array for
option-bearing fields. This gives `name` → DOM element `id`/`name` mapping directly (Greenhouse's
rendered inputs use the same `name`/`id` as the API's `fields[].name`, confirmed by matching
`resume`/`first_name`/etc. between the API response and the live HTML). **This is a much more
reliable source of field type + required + options than DOM scraping and should be the primary
detection path when the board token is extractable from the URL** (`job-boards.greenhouse.io/{board_token}/jobs/{job_id}`).

---

## Lever (`jobs.lever.co`)

**1. Rendering pattern.** Live `curl` of a real posting/apply page
(`https://jobs.lever.co/palantir/{postingId}/apply`, posting ID obtained from Lever's own public
Postings API) returned ~1.9MB of HTML containing **one fully server-rendered `<form
id="application-form" enctype="multipart/form-data" method="POST">`** with 69 `<input>`, 2
`<select>`, 3 `<textarea>` elements already present before JS runs. Scripts loaded include
jQuery, `parseResume.js`, `application.js`, hCaptcha — progressive-enhancement style, not an SPA
shell. **Verified directly.**

**2. Field widget patterns.** Mixed: standard demographic/EEO-style questions use **native
`<select name="cards[{cardId}][field0]" required>`** (2 present). Custom "multiple choice"
questions (e.g. "Are you legally authorized to work...?", visa sponsorship) render as native
`<input type="radio">` grouped in `<ul data-qa="multiple-choice"><li><label><input type="radio"
...><span class="application-answer-alternative">Yes</span></label></li>...</ul>` — real radio
buttons, not a custom widget. Checkbox groups use `data-qa="checkboxes"` with the same native
`<input type="checkbox">` pattern (inferred from the `data-qa` naming; not itself expanded in the
fetched sample — low-confidence, **needs live verification** for exact markup). **Verified
directly** for select/radio.

**3. Required-field signaling.** Native HTML5 `required` attribute is present on every required
`<input>`/`<select>` (confirmed: `<input type="text" ... required>`, `<select ... required>`,
`<input type="radio" ... required="required">`), _plus_ a visible `<span class="required">✱</span>`
sibling inside the label div, _plus_ a `data-qa="SCL-question-required-asterisk"` marker for
custom questions. Triple-redundant like Greenhouse. **Verified directly.**

**4. Label association.** **Label-wraps-input with no `for` attribute** — e.g.
`<label><div class="application-label">Full name<span class="required">✱</span></div>
<div class="application-field"><input type="text" name="name" required></div></label>`. This is
implicit (wrapping) association, not `for`/`id`. For radio/checkbox groups, the group-level
question text sits in a **sibling `<div class="application-label ...">` detached from the
`<ul>`/`<input>` list** (only individual option labels wrap their own radio input). **Verified
directly.**

**5. File upload mechanism.** Native `<input type="file" name="resume" class="application-file-input
invisible-resume-upload" id="resume-upload-input">`, visually hidden, wrapped in a clickable
`<a class="postings-btn ... visible-resume-upload">`. An `upload-dragging` CSS class exists in the
page's stylesheet/markup, implying the wrapper _does_ listen for `dragenter`/`dragleave` to toggle
a hover style — but the underlying element is still a native file input, so the same
`Object.defineProperty(.files, ...)` + `change` event technique used today should work; a
`dragover`/`drop` simulation may additionally be needed if Lever's JS only reads
`DataTransfer.files` from a `drop` event rather than the input's own `change` (**needs live
verification** — can't confirm which listener actually processes the file without executing the
page's JS).

**6. Public API.** Lever's public Postings API
([github.com/lever/postings-api](https://github.com/lever/postings-api)) — confirmed via fetch —
provides job listing/detail/submit endpoints but **explicitly does not expose custom
question/form schema**: "does not... expose custom questions built into your job postings."
Submission accepts standard fields (name, email, phone, resume, links, comments) but
company-specific screening questions must be discovered from the rendered form itself. **No
API-based detection shortcut for custom questions on Lever — DOM scraping is the only option**,
unlike Greenhouse/Ashby/SmartRecruiters/Workable.

---

## Workday (`*.myworkdayjobs.com`, apply flow eventually lands on `*.wd{1,3,5}.myworkday.com` or stays on `myworkdayjobs.com`)

**1. Rendering pattern.** Live `curl` of `https://workday.wd5.myworkdayjobs.com/Workday` (no JS)
returned only 8,476 bytes: `<body><div id="root"></div></body>` with a single inline
`<script type="text/javascript">` that dynamically injects a bundle script tag — **zero
`<input>`/`<select>`/`<form>` elements in the raw response**. This is a pure client-rendered SPA
shell; **confirmed directly** that a raw fetch gets nothing usable, exactly as the task
anticipated.

**2–5. Field widgets / required signaling / label association / file upload.** **Needs live
verification** — cannot be inspected without executing Workday's JS bundle (no browser-automation
tool available this session). Third-party technical write-ups (not primary source, used only to
know where to look) describe Workday's underlying data layer as "CXS" (Candidate Experience
System) — every career site is a SPA that calls a JSON endpoint at
`https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`. This is _not_ an
officially documented public API — Workday's own developer docs live behind a login wall at
`community.workday.com/api` (login-gated, could not access). Workday's apply flow is also known
(from general product familiarity, unverified here) to require account creation and often
multi-step wizard pages with heavy custom widget usage (Workday's own "WD" component library);
expect non-native `<select>` replacements, custom multi-select "tag" pickers, and possibly nested
iframes for embedded steps (e.g. background-check consent). **All of this needs live verification
before implementation** — do not build Workday-specific selectors from this doc alone.

**6. Public API.** No confirmed public/documented job-board API with question schema. The CXS
JSON endpoint pattern above is undocumented/reverse-engineered per third-party sources, not an
official Workday product surface — treat as unstable and not a safe long-term integration target
without Workday's explicit documentation. **DOM-based detection (post-live-verification) is the
only realistic path for Workday**, and it is the platform where our generic heuristic pipeline
matters most.

---

## iCIMS (`*.icims.com`, e.g. `careers-{company}.icims.com`)

**1. Rendering pattern.** Live `curl` of a real iCIMS-hosted career site
(`careers-petsuppliesplus.icims.com/jobs/search?ss=1`) returned a **Next.js SPA**
(`/_next/static/chunks/...` bundle references, `webpack-*.js`, `framework-*.js`) with 0 `<input>`
in the raw HTML and a `<script>`-embedded `__NEXT_DATA__` JSON blob (534KB) carrying page/layout
data (Sitecore-CMS-backed marketing content in the sample fetched, not job/application data —
the specific job-search results are fetched client-side). Notably the page includes a **`<noscript>`
fallback `<iframe src="https://careers-{company}.icims.com/jobs/search?ss=1&in_iframe=1"
id="noscript_icims_content_iframe">`** for JS-disabled browsers — confirming iCIMS explicitly
supports/expects an iframe-embedded mode as one of its delivery mechanisms (`in_iframe=1` query
param), which matters for `all_frames`/host-permission planning even though the _default_
experience for this instance is not iframe-embedded. **Verified directly**, though this is one
customer's iCIMS instance/theme (iCIMS supports multiple career-site "eras" — legacy vs. modern —
so markup likely varies by customer/theme; **treat the exact widget markup as needs live
verification per-tenant**.

**2–5. Field widgets / required signaling / label association / file upload.** **Needs live
verification** — the application form itself is several navigation steps beyond the JS-rendered
job search/listing page reached here, and requires JS execution to inspect. iCIMS's own docs
(`community.icims.com`) describe **iForms** as "electronic data collection forms housed within the
iCIMS Talent Platform and permanently stored within the Platform" — this is iCIMS's own name for
its form technology, implying custom-rendered forms rather than plain server HTML, consistent
with the Next.js SPA evidence above, but the specific widget markup (native `<select>` vs custom,
required-signal attribute, drag/drop file zone) could not be confirmed this session.

**6. Public API.** iCIMS exposes a **Job Portal API** and a **Profiles Endpoint** ("interacting
with field information... plus schema details for specified data") per
[iCIMS Developer Community](https://developer-community-stg.icims.com/applications/icims-applicant-tracking)
— found via search, not independently fetched/confirmed this session (the developer community
site requires auth/is a staging URL). **Whether it exposes per-job application-question schema
(the equivalent of Greenhouse/Ashby's `questions`/`applicationFormDefinition`) is unconfirmed —
needs live verification against actual iCIMS developer docs with a registered account.**

---

## Ashby (`jobs.ashbyhq.com`)

**1. Rendering pattern.** Live `curl` of `https://jobs.ashbyhq.com/Ashby` returned a **client-rendered
SPA shell**: `<div id="root">`, `id="vite-preload"`, `id="csp-nonce"` (Vite-bundled app), **zero
`<input>` elements** in the raw HTML. **Confirmed directly** that raw fetch gives only the shell,
matching the task's expectation — DOM widget details (native vs. custom select, required
signaling, label association, file upload mechanism) are **needs live verification**.

**6. Public API — this is the standout finding for Ashby.** Ashby's
[Job Board API](https://developers.ashbyhq.com/docs/public-job-posting-api) /
[`jobPosting.info`](https://developers.ashbyhq.com/reference/jobpostinginfo) endpoint returns an
**`applicationFormDefinition`** object (`OverlayFormDefinition`) — confirmed via fetch of the
reference doc — containing `sections[].fields[]`, each with `type` (e.g. `"String"`),
`isRequired` (boolean), `selectableValues` (`[{label, value}]` for choice fields), `title`,
`path`, `humanReadablePath`. This is a **complete, typed schema of the entire application form**,
including required flags and every dropdown/multi-select's options — the richest of any platform
checked. Ashby also documents submitting applications via
`applicationForm.submit` with `multipart/form-data` (for résumé upload) — i.e. Ashby's API can
plausibly be used for both _reading_ the form schema and (if we ever go that route)
_submitting_ without touching the DOM at all. **This makes Ashby the strongest candidate for an
API-first (non-DOM) detection+fill strategy** — see "Detection strategy" below.

---

## SmartRecruiters (`*.smartrecruiters.com`, `jobs.smartrecruiters.com`)

**1. Rendering pattern.** `jobs.smartrecruiters.com/SmartRecruiters` returned an HTTP 301 redirect
in this session (didn't resolve to a stable inspectable page); not independently confirmed via raw
DOM this session — **needs live verification**. SmartRecruiters' own developer docs
([developers.smartrecruiters.com/docs/posting-api](https://developers.smartrecruiters.com/docs/posting-api),
fetched) explicitly frame the platform as **API-first**: "SmartRecruiters Posting API allows our
customers to build fully customizable career sites... you host the career site and only consume
jobs data from SmartRecruiters" — meaning **rendering is customer-controlled and not
standardized**; expect wide DOM variance between SmartRecruiters customers (some may even reuse
Greenhouse/Lever-style patterns since they own their own markup). SmartRecruiters-hosted default
career sites (as opposed to fully custom ones) likely still exist but weren't reachable this
session — **needs live verification**.

**6. Public API.** **Confirmed via fetch of
[developers.smartrecruiters.com/docs/get-application-screening-questions-and-privacy-policies](https://developers.smartrecruiters.com/docs/get-application-screening-questions-and-privacy-policies):**
`GET /postings/{uuid}/configuration` returns a `questions[]` array with `fields[]` entries each
carrying `type` (`INPUT_TEXT`, `SINGLE_SELECT`, `MULTI_SELECT`, `RADIO`, `CHECKBOX`, `TEXTAREA`,
`INFORMATION`), `required` (boolean), and `values: [{id, label}]` for choice fields — same shape
of usefulness as Greenhouse/Ashby. **Preferred detection path exists**, but since customers can
fully custom-build their career site (point 1), the API-reported field types won't always
correspond 1:1 to predictable DOM element `name`/`id` attributes the way Greenhouse's do —
**needs live verification** whether SmartRecruiters' own hosted-widget mode preserves that
mapping.

**2–5.** **Needs live verification** — no live DOM sample obtained this session.

---

## Workable (`apply.workable.com`, `jobs.workable.com`)

**1. Rendering pattern.** A live job-apply URL fetched this session
(`apply.workable.com/j/2CF1C90531`) returned only an HTTP 302 with no discoverable page content
(job posting likely expired/removed) — **not independently confirmed via raw DOM this session,
needs live verification**. Workable's own help docs (fetched:
[help.workable.com — Using the Workable API to create a careers page](https://help.workable.com/hc/en-us/articles/115012771647-Using-the-Workable-API-to-create-a-careers-page),
[Customizing the application form](https://help.workable.com/hc/en-us/articles/115012231948-Customizing-the-application-form))
confirm careers pages can be either Workable-hosted or fully custom-built off the API, similar to
SmartRecruiters — expect DOM variance.

**6. Public API.** Per search of Workable's docs (not independently fetched — the direct
`workable.readme.io` reference URL 404'd this session, so treat with slightly lower confidence
than Greenhouse/Ashby/SmartRecruiters): a `GET /jobs/{shortcode}/questions` endpoint returns
"application questions for a job," and a documented `GET
https://{subdomain}.workable.com/spi/v3/jobs/{shortcode}/application_form` endpoint returns
`form_fields[]` and `questions[]` arrays for the full application form. **Likely a preferred
detection path exists (matching the Greenhouse/Ashby/SmartRecruiters pattern), but the exact field
schema (type enum values, required flag name, options shape) is unconfirmed — needs live
verification** by fetching the endpoint directly against a real job before relying on it.

**2–5.** **Needs live verification.**

---

## BambooHR (`*.bamboohr.com`)

**1. Rendering pattern.** Live `curl` of BambooHR's own careers/application page
(`bamboohr.com/careers/application`) returned a **client-rendered shell**: `<div
class="job-application"></div>` empty, with `<script src="/scripts/scripts.js" type="module">` —
zero `<input>`/`<form>` in the raw HTML. **Verified directly** for BambooHR's own site; since
BambooHR ATS is typically embedded as a widget on _customer_ career pages rather than visited
directly, third-party customer instances may differ in host/embed details — **needs live
verification** for a real customer-hosted BambooHR careers widget specifically (only BambooHR's
own dogfooded page was checked here).

**2–5.** **Needs live verification** — the empty shell gives no widget/label/required/file-upload
evidence.

**6. Public API.** BambooHR's [Applicant Tracking API reference](https://documentation.bamboohr.com/reference/applicant-tracking)
(fetched) covers **internal recruiter-side operations only** — job summaries, applications,
comments, applicant statuses — authenticated with an API key. **No evidence of a public,
unauthenticated endpoint exposing a careers-page job's application-form question schema** (unlike
Greenhouse/Ashby/SmartRecruiters). **This means BambooHR has no API-based detection shortcut for
candidate-facing form fields — DOM scraping only, and needs live verification to build it.**

---

## Detection strategy — what landed

This section used to propose seven extension points (a–g). All of them were built; it now records
where each one lives, so the research above stays useful without reading as an open to-do list.

| Proposed                                                                             | Landed as                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) `required` on `DetectedField`, and an element-role axis separate from category   | `DetectedFieldSchema.required` and `ElementRoleSchema` (`'native' \| 'combobox' \| 'radiogroup' \| 'checkboxgroup'`) in `packages/shared/src/detectedField.ts` — the enum shipped as proposed                                                          |
| (b) second scan pass for comboboxes and radio/checkbox fieldsets                     | `content/detectFields.ts`. A choice group is **one** Detected Field with its choices as `options`, not N fields                                                                                                                                        |
| (c) `getSignal()` label resolution: implicit-wrap `<label>`, `aria-labelledby`       | `content/detectFields.ts`                                                                                                                                                                                                                              |
| (d) required-signal helper (`required` / `aria-required` / ancestor / asterisk span) | `content/detectFields.ts`                                                                                                                                                                                                                              |
| (e) per-platform API oracle tried alongside DOM scraping                             | `background/apiDetectors.ts` — three oracles (Greenhouse, SmartRecruiters, Workable) behind one `AtsOracle` interface. Confirms the doc's conclusion: the API supplies _classification, required and options_; the DOM stays the _targeting_ mechanism |
| (f) real `DataTransfer` for the file-upload drop path                                | `content/fillForm.ts`'s `attachResumeFile`, with the old shim kept only as a jsdom fallback                                                                                                                                                            |
| (g) `all_frames: true`                                                               | `manifest.ts` — needed more than anticipated, since an ATS form is usually in an iframe on a company's own careers page                                                                                                                                |

Two things the research did not anticipate, learned from live use and worth carrying into any
further platform work:

- **Setting `.value` is not enough on a React-controlled form.** React installs an instance-level
  `value` accessor that keeps its own cache in lockstep with direct assignment, so its change
  detection sees nothing and the value is reverted on the next render. Writes must go through the
  _prototype's_ setter, and the fill must drive the full keystroke sequence
  (`focus` → `input` → `change` → `blur`) — form libraries commonly commit to the form model on
  blur, so a fill that never blurs leaves the DOM looking right and the model empty.
- **A fill must be verified, not assumed.** `fillForm` re-reads each field after a settle delay and
  reports only the ids that verifiably still hold their value; the Fill Step's counts come from
  that reply rather than from the values it sent.

### Platform priority

Unchanged from the original research, and still the right order:

1. **Greenhouse** — common, and the cleanest public API (`?questions=true`). Its react-select
   comboboxes and checkbox fieldsets were the original motivating failure; both are handled now,
   and its oracle is the only one confirmed against a live posting.
2. **Lever** — common and DOM-verified. Its labels are wrap-associated rather than `for`-bound,
   which the label-resolution work above recovers. No API for custom questions — DOM only.
3. **Workday** — common, pure SPA, no static markup. Needs live verification before selector work.
4. **iCIMS** — common, Next.js SPA, iframe-capable. Needs live verification of the apply form.
5. **Ashby** — best public form schema of any platform, so it's cheap to support _well_, but it
   currently has **no oracle**: the one that shipped called an endpoint that only ever 401'd, and it
   was removed along with its host permission. The unauthenticated endpoint that does work, its
   query and its response shape are documented in `background/apiDetectors.ts`'s comments, and
   rebuilding from them is the highest-value oracle work left.
6. **SmartRecruiters / Workable** — API-first with per-customer DOM variance; both oracles ship
   unverified.
7. **BambooHR** — no public form-schema API and an embedded widget on third-party pages. Lowest
   priority.
