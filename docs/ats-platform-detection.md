# ATS platform detection — research for generalizing field detection

## Why this doc exists

We diagnosed a concrete bug: on Greenhouse (`job-boards.greenhouse.io`), `detectFields.ts` only
queries `input, textarea, select`, then classifies each element's label/aria-label/placeholder/name
text against a fixed `KEYWORD_RULES` / `FILE_KEYWORD_RULES` list (`packages/shared/src/schemas.ts`'s
`FieldCategorySchema`). Anything unmatched only becomes a fillable `'question'` if it's a
`<textarea>` with question-shaped text. Live inspection of a real Greenhouse job page (below)
confirms the root cause: Greenhouse's required screening questions (work authorization,
sponsorship, "how did you hear about us", location) are rendered as **react-select comboboxes**
— `<input role="combobox">` wrapped in `div.select__*` markup — not `<select>` elements, so they
are invisible to `detectFields.ts`'s query entirely. Multi-choice questions use native
`<fieldset>`/`<input type="checkbox">` groups, also unhandled. `attachResumeFile` in `fillForm.ts`
shadows a native file input's `files` property and fires `change`, which works for Greenhouse's
default embed (confirmed native, non-dropzone `<input type="file">`) but may not for platforms
with real drag/drop dropzone widgets.

This doc feeds a decision: **how to extend `detectFields.ts`/`fillForm.ts`/`DetectedFieldSchema`
per-platform**, prioritized by how common each ATS is and how badly detection currently fails on
it. Platforms covered: Greenhouse, Lever, Workday, iCIMS, Ashby, SmartRecruiters, Workable,
BambooHR — matches the existing `ATS_DOMAINS` allowlist in
`apps/extension/src/lib/atsHosts.ts`.

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
file group's *visible* label ("Resume/CV *") is a plain `<div id="upload-label-resume">` referenced
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
`<input type="radio" ... required="required">`), *plus* a visible `<span class="required">✱</span>`
sibling inside the label div, *plus* a `data-qa="SCL-question-required-asterisk"` marker for
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
page's stylesheet/markup, implying the wrapper *does* listen for `dragenter`/`dragleave` to toggle
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
`https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`. This is *not* an
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
param), which matters for `all_frames`/host-permission planning even though the *default*
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
plausibly be used for both *reading* the form schema and (if we ever go that route)
*submitting* without touching the DOM at all. **This makes Ashby the strongest candidate for an
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
BambooHR ATS is typically embedded as a widget on *customer* career pages rather than visited
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

## Detection strategy

Concrete, incremental extensions to the actual files in this repo — not a rewrite.

### Priority order

1. **Greenhouse** — highest priority: common, and we have concrete live-DOM evidence the current
   pipeline fails on it (react-select comboboxes + checkbox fieldsets invisible to `input,
   textarea, select`). Also the platform with the cleanest public API (`?questions=true`).
2. **Lever** — common, DOM-verified, and unlike Greenhouse, `<select>`/`<input type=radio>` *are*
   already in-scope for `detectFields.ts`'s query — but `classify()`'s keyword list won't fire
   correctly on Lever's `application-label` div text since it's not `<label for>`-bound, so the
   `getSignal()` fallback chain currently returns `''` for wrapped/detached labels. Fixing label
   resolution alone recovers most of Lever.
3. **Workday** — common, confirmed pure SPA with zero static markup; needs live verification
   before any selector work, but is worth prioritizing given prevalence once verified.
4. **iCIMS** — common, confirmed Next.js SPA + iframe-capable; needs live verification of the
   actual apply-form DOM.
5. **Ashby** — has the best public API (`applicationFormDefinition`), so it's cheap to support
   *well* even though raw DOM is a SPA shell — API-first, not DOM-first.
6. **SmartRecruiters / Workable** — both API-first platforms with per-customer DOM variance; same
   playbook as Ashby (prefer API, DOM as fallback), lower priority since less commonly encountered.
7. **BambooHR** — lowest priority of the eight: no public form-schema API, and it's an embedded
   widget on third-party pages, meaning host/iframe targeting is itself uncertain without live
   verification.

### Concrete extension points

**a) `DetectedFieldSchema` (`packages/shared/src/schemas.ts`)** — add:
- `required: z.boolean()` — every platform checked so far signals required via *some* combination
  of `required`/`aria-required="true"`/a visual asterisk/`data-required`; capturing it lets the
  backend prioritize which `question` fields absolutely need an answer vs. can be skipped, and
  lets the popup warn before submit.
- Extend `FieldCategorySchema` with multi-choice-aware categories, or (simpler, less schema churn)
  add an `elementRole: z.enum(['native', 'combobox', 'radiogroup', 'checkboxgroup'])` so
  `fillForm.ts` knows *how* to fill a field, independent of its semantic `category`.

**b) `detectFields.ts` element scan** — the current `doc.querySelectorAll('input, textarea,
select')` misses every pattern seen on Greenhouse. Add a second pass:
```ts
doc.querySelectorAll('[role="combobox"], [role="listbox"], fieldset[role], fieldset:has(input[type="radio"],input[type="checkbox"])')
```
For `role="combobox"` elements (react-select-style, confirmed on Greenhouse): the *displayed*
value isn't in `.value` the way a native input is — react-select renders selected text into a
sibling `select__single-value` div and keeps the actual answer in React state, submitted via a
hidden hidden-input pattern (Greenhouse: a `remix-css-*-requiredInput`) or a same-`name` hidden
field. Filling these requires **simulating the widget's real interaction** (click to open →
click/keyboard-select the matching `role="option"` inside the portal at
`#react-portal-mount-point`, not just setting `.value`) rather than the current `el.value = ...;
dispatchEvent('input')` approach in `fillForm.ts` — flag this as the biggest `fillForm.ts` change
needed, not just a `detectFields.ts` one.

For `fieldset`-wrapped radio/checkbox groups (confirmed on both Greenhouse and Lever): treat the
whole `fieldset` as one `DetectedField` whose `selector` resolves to the group, with the group's
`<legend>`/detached label div as the signal text, and store each `<input>`'s `value` as an option
— this needs a new `DetectedField` shape (a `fields: string[]` sub-array or similar) rather than
one field = one element, since one question maps to N radio/checkbox inputs.

**c) `getSignal()` label resolution** — currently only checks `label[for={id}]` then
aria-label/placeholder/name/id. Add, in order:
1. Nearest ancestor `<label>` with no `for` (implicit wrap — confirmed pattern on Lever's
   `application-label` and Greenhouse's checkbox `<legend>`).
2. `aria-labelledby` resolution (confirmed pattern on Greenhouse's comboboxes and file-upload
   group) — split on whitespace, concatenate each referenced element's `textContent`.
3. A sibling/ancestor text node containing a `*`/`required`-styled span near the field, purely for
   the *required* signal (not the label signal) — feeds the new `required` field in (a).

**d) Required-field signal extraction** — a small helper, checked in this priority order (all
confirmed as real patterns across Greenhouse/Lever):
```ts
el.required || el.getAttribute('aria-required') === 'true' ||
  el.closest('[aria-required="true"]') != null ||
  !!nearestLabelOrLegend(el)?.querySelector('.required, [class*="required"]')
```

**e) Per-platform API-based detection as a preferred path** — add a small `apiDetectors` module
keyed by hostname, tried *before* DOM scraping, falling back to DOM scraping if the API call fails
or the current page isn't identifiable as a specific job (e.g. board token / posting ID not
extractable from the URL):
- **Greenhouse**: `GET boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true`
  — board token is the first path segment after the host on `job-boards.greenhouse.io/{board_token}/jobs/{job_id}`
  (verified against the live URL used in this research).
- **Ashby**: `jobPosting.info` → `applicationFormDefinition` (richest schema of any platform
  checked) — needs Ashby's job-board API key/org identifier; check
  `developers.ashbyhq.com/docs/public-job-posting-api` for auth requirements before implementing.
- **SmartRecruiters**: `GET /postings/{uuid}/configuration`.
- **Workable**: `GET {subdomain}.workable.com/spi/v3/jobs/{shortcode}/application_form` — verify
  the actual shape live before relying on it (this session's fetch of the reference page 404'd).
- **Lever, Workday, iCIMS, BambooHR**: no confirmed public form-schema API — DOM-only.

Even where an API exists, the API gives *schema*, not the *live DOM element* to fill — still need
to map each API `question`/`field` back to the actual rendered input (by `name`/`id`, confirmed to
match 1:1 on Greenhouse) so `fillForm.ts` has something to target. Treat the API as an oracle for
*classification/required/options*, DOM scraping as the *targeting* mechanism, for platforms where
both exist.

**f) `fillForm.ts` — drag/drop fallback for file uploads.** Current `attachResumeFile` shadows
`.files` and fires `change` only. Confirmed sufficient for Greenhouse's default embed (plain
hidden `<input type="file">`, no drag listeners found). Lever's `upload-dragging` CSS class hints
its widget *may* listen for `dragenter`/`dragleave`/`drop` rather than (or in addition to)
`change` — needs live verification, but cheap to add defensively:
```ts
const dt = new DataTransfer();
dt.items.add(file);
for (const type of ['dragenter', 'dragover', 'drop']) {
  dropzone.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer: dt }));
}
```
dispatched at the *dropzone wrapper* element (nearest ancestor with a class/attribute suggesting
drop-target styling, e.g. containing "drop"/"dragging" in its class list) in addition to the
existing `change`-event technique on the native input, so both listener styles are covered without
knowing in advance which one a given platform's JS actually reads.

**g) Manifest / iframe reach (`apps/extension/src/manifest.ts`).** Current `content_scripts` entry
has no `all_frames: true`. iCIMS confirmed to support an iframe-embedded mode
(`in_iframe=1` fallback pattern seen live); Workday/BambooHR embeds on third-party marketing sites
sometimes also run inside iframes (unverified this session but a well-known pattern for embeddable
widgets). Add `all_frames: true` to the existing `content_scripts` entry — host permissions already
cover `*.icims.com` etc. via `ATS_HOST_PATTERNS`, so no manifest permission change needed, just the
`all_frames` flag, plus a same-origin guard in `content/index.ts` so the script doesn't do
redundant work if the iframe's `document` is same-origin as the parent (rare) vs. cross-origin (the
common case, where `all_frames` is the only way in).
