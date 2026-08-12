# Why djobi fails to fill + upload on Ashby after pasting a job description

Companion to `docs/ats-platform-detection.md`, which flagged Ashby's DOM behaviour as
"needs live verification". This doc closes several of those gaps with direct evidence and
diagnoses a specific reported failure.

## Question

On `https://jobs.ashbyhq.com/outset/55d672a5-823b-4ad3-9e06-5c7f8aff529a/application`, the user
pastes a job description into the side panel, clicks **Analyze**, gets a review, clicks
**Fill form** — and nothing is filled and no resume is uploaded. Why?

All repo citations are `path:line` against the working tree at the time of writing
(branch `fix_autofill`). All external claims cite the source that owns them; nothing here comes
from a blog post.

> **Note on cause 1 / fix F1.** While this was being written, a concurrent change appeared in the
> working tree that deletes `background/jobPageStore.ts` and `lib/pipelineRunStore.ts` in favour of
> a unified `lib/tabStore.ts` backed entirely by `chrome.storage.session`. Its own docstring names
> the same defect diagnosed below ("the `Map` died whenever the service worker was evicted (~30s
> idle), silently losing a detected job page"). Cause 1's analysis and citations describe the code
> as it was; if `tabStore.ts` lands, F1 is already addressed and the line numbers in §1 will have
> moved. **Causes 2, 3, 5, 6 and 7 are untouched by that refactor.**

---

## Summary of root causes, ranked

| # | Cause | Confidence | Blocks fill? | Blocks upload? |
|---|---|---|---|---|
| 1 | `jobPageStore` is an in-memory `Map` in the MV3 service worker. Pasting a JD reliably idles the worker past its 30s termination timeout, so `runAnalysis` re-reads `null` and pins `fields: []` into the durable run state. The Fill Step then has literally nothing to fill and never even fetches the PDF — and reports success. | **High — code-proven** | Yes, totally | Yes, totally |
| 2 | `fillForm` assigns `el.value = value` directly. Ashby's form is React-controlled; React's value tracker makes this a no-op for `onChange`, so even with correct fields the text never enters Ashby's state and is reverted on the next render. | **High — React source-proven** | Yes | No |
| 3 | `attachResumeFile`'s fake `dataTransfer` sets `items: { add: () => {} }`. Ashby uses **react-dropzone**, whose `file-selector` takes the `items` branch whenever `items` is truthy and iterates `items.length` (`undefined`) → **zero files**. The `files` array is never read. | **High — bundle-proven** | No | Yes (drop path) |
| 4 | Detection is one-shot and fires on the *first* `input[type="file"]` to appear. Ashby renders the entire form client-side after an async GraphQL fetch, so the snapshot can be partial, and there is no re-scan. | Medium-high | Partially | Partially |
| 5 | `enrichWithAshbyApi` targets an endpoint that returns **401** and parses a response shape Ashby does not serve at that path. The Ashby oracle is dead code — it can never repair (4). | **High — live 401** | — | — |
| 6 | This posting's first required field is titled exactly `"Name"`. `KEYWORD_RULES` has no rule for a bare "name", so it classifies as `unknown` and is never given a value. | **High — live API-proven** | Yes, for that field | No |
| 7 | Failure is silent: `unresolvedRequiredFields` is computed by filtering the (empty) `fields` array, so a fill that did nothing renders "✅ Filled and application saved." | High | — | — |

Causes 1–3 are independent. Fixing only #1 exposes #2 and #3; fixing only #2/#3 still leaves #1
producing an empty fill.

---

## Evidence

### 0. Ashby *is* reachable — the manifest is not the problem

`apps/extension/src/manifest.ts:36-47` matches `http://*/*` and `https://*/*` with
`all_frames: true`, so the content script is injected on `jobs.ashbyhq.com`. This is deliberate
(`manifest.ts:38-41`). The paste flow does not bypass the content script either: the panel tracks
the real tab (`apps/extension/src/panel/App.tsx:160-176`) and `FILL_FORM` is sent to that tab id
(`apps/extension/src/background/pipelineRunner.ts:30-37`). **Injection and tab targeting are fine.**

`host_permissions` (`manifest.ts:48-54`) includes `https://api.ashbyhq.com/*` but **not**
`https://jobs.ashbyhq.com/*` — relevant only to the fix for cause 5, below.

### 1. The service worker's in-memory `Map` loses the fields while the user is pasting

`apps/extension/src/background/jobPageStore.ts:8` stores detected fields in a plain module-level
`Map`:

```ts
const jobPageDataByTab = new Map<number, JobPageData>();
```

Chrome's own docs state the worker is torn down
"[after 30 seconds of inactivity](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)"
and that "any global variables you set will be lost if the service worker shuts down."

The repo already knows this. `apps/extension/src/lib/pipelineRunStore.ts:9-13` says it uses
`chrome.storage.session` "rather than an in-memory `Map` — it needs to survive not just the panel
closing (which `jobPageStore.ts` was built for) but also the background service worker being
evicted after ~30s idle". `jobPageStore` was simply never migrated.

Reading a job description and pasting it into a textarea takes well over 30 seconds. The panel does
not keep the worker alive — it only calls `chrome.storage.session` (a *trusted-context* API the
panel calls directly, `pipelineRunStore.ts:14-17`), never messaging the background. So by the time
**Analyze** is clicked, the `Map` is empty.

The chain that follows:

1. `App.tsx:285-302` — `handleAnalyze` sends `START_ANALYSIS` carrying only
   `{ tabId, tabUrl, profile, pageTextOverride }`. **It does not send `jobPageData.fields`**, even
   though the panel holds them in state.
2. `App.tsx:292` — `if (!jobPageData) setJobPageData({ pageText, fields: [] });` is a local React
   `setState` only; the background never sees it.
3. `pipelineRunner.ts:59-63` — the background re-derives the data from the wiped `Map`:
   ```ts
   const detected = getJobPageData(tabId);            // → null
   const jobPageData = detected ? { ...detected, pageText } : { pageText, fields: [] };
   ```
4. `pipelineRunner.ts:65-75` — that `fields: []` is written to `chrome.storage.session` as the
   authoritative run state.
5. `App.tsx:245-269` — the panel's `chrome.storage.onChanged` subscriber then **overwrites its own
   good local copy** with the empty one (`App.tsx:258`).
6. `pipelineRunner.ts:93-110` — `runFill` reads `run.jobPageData` back out of storage, so
   `fillAndSubmit` receives `fields: []`.
7. `apps/extension/src/panel/pipeline.ts:108-117` — the values loop iterates an empty array →
   `values = {}`.
8. `pipeline.ts:122-133` — `resumeUploadField` is `undefined`, so `fetchResumePdf` is **never
   called** and `resumeFile` stays `undefined`. The resume is not merely mis-attached; it is never
   rendered.
9. `apps/extension/src/content/index.ts:27-45` — the content script receives `fields: []` and no
   `resumeFile`. `fillForm` loops zero times; the upload block is skipped.

This alone fully reproduces the reported symptom, independent of any DOM issue.

### 2. React controlled inputs ignore `el.value = x` + `new Event('input')`

`apps/extension/src/content/fillForm.ts:138-140`:

```ts
el.value = value;
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

Why this fails, from React's own source
([`react-dom-bindings/src/client/inputValueTracking.js`](https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/client/inputValueTracking.js)):
on mount, `track(node)` installs an **instance-level** accessor that shadows the prototype's,
wrapping the native getter/setter and caching the last value:

```js
const descriptor = Object.getOwnPropertyDescriptor(node.constructor.prototype, valueField);
const {get, set} = descriptor;
Object.defineProperty(node, valueField, {
  get: function () { return get.call(this); },
  set: function (value) { currentValue = '' + value; set.call(this, value); },
});
```

Assigning `el.value` therefore runs React's own setter, which updates `currentValue` in lockstep.
The gate then sees no change:

```js
export function updateValueIfChanged(node) {
  const tracker = getTracker(node);
  const lastValue = tracker.getValue();
  const nextValue = getValueFromNode(node);
  if (nextValue !== lastValue) { tracker.setValue(nextValue); return true; }
  return false;
}
```

And [`ChangeEventPlugin.js`](https://github.com/facebook/react/blob/main/packages/react-dom-bindings/src/events/plugins/ChangeEventPlugin.js)
gates text-input `input`/`change` on exactly that boolean:

```js
function getInstIfValueChanged(targetInst) {
  const targetNode = getNodeFromInstance(targetInst);
  if (updateValueIfChanged(targetNode)) { return targetInst; }
}
function getTargetInstForInputOrChangeEvent(domEventName, targetInst) {
  if (domEventName === 'input' || domEventName === 'change') {
    return getInstIfValueChanged(targetInst);
  }
}
```

No fiber returned → no synthetic `onChange` → Ashby's state never updates → the DOM value is
reverted on the next render, and submission sends nothing.

**The correct approach** is to bypass the instance accessor by invoking the *prototype's* setter
with the element as receiver, leaving the tracker holding the stale value so the comparison
succeeds:

```ts
const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

`fillForm.ts` does **not** do this anywhere. The same bug is in `fillSelect`
(`fillForm.ts:48-50`), though `<select>` happens to escape it: `shouldUseChangeEvent`
(`ChangeEventPlugin.js:77-84`) routes `select` and `input[type=file]` to
`getTargetInstForChangeEvent`, which returns the fiber unconditionally with no tracker gate.
`fillGroup` (`fillForm.ts:62-79`) uses `.click()`, which is the correct, tracker-safe path.

The tests cannot catch this: `apps/extension/src/content/fillForm.test.ts` runs under jsdom, where
no React tracker is installed, so a bare `el.value = x` passes trivially.

### 3. Ashby renders client-side; the form is react-dropzone

`curl` of the application URL with a browser UA returns **HTTP 200, 23,674 bytes** containing
`<div id="root">`, `id="vite-preload"`, `id="csp-nonce"`, `window.__appData` — and
**zero `<input>` and zero `<form>` elements**. This confirms and extends the
`docs/ats-platform-detection.md` Ashby section: the `/application` route is a Vite-built SPA shell
with no server-rendered markup at all.

`window.__appData` carries org metadata only (`organizationId`, `hostedJobsPageSlug: "outset"`,
feature flags) — **no form definition**. The form is fetched at runtime.

The real form definition is served, unauthenticated, by Ashby's internal GraphQL endpoint. Live
call to `POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` with
`jobPosting(organizationHostedJobsPageName:"outset", jobPostingId:"55d672a5-…") { applicationForm { sections { title fieldEntries { field isRequired } } } }`
returns:

| Title | `type` | required | `path` |
|---|---|---|---|
| `Name` | String | true | `_systemfield_name` |
| `Email` | Email | true | `_systemfield_email` |
| `LinkedIn URL` | String | false | `098eec66-…` |
| `Resume` | File | true | `_systemfield_resume` |
| `Are you legally authorized to work in the United States?` | Boolean | true | `a50b6888-…` |
| `Will you now or in the future require sponsorship…?` | Boolean | true | `4445bfff-…` |
| `Are you willing to work onsite 4 days a week from our SF office?` | Boolean | true | `9ac10505-…` |
| `In one sentence, what are you most proud of professionally?` | LongText | true | `8604655f-…` |

Note the shape is `applicationForm.sections[].fieldEntries[].field` with `isRequired` on the
**entry**, not `applicationFormDefinition.sections[].fields[]` with `isRequired` on the field.

**The upload widget.** The entry bundle
(`https://cdn.ashbyprd.com/frontend_non_user/<sha>/assets/index-BHgQsHyZ.js`, ~4 MB, located via
the Vite manifest linked from `id="vite-preload"`) contains exactly one `type:` file` occurrence,
inside an unmistakable **react-dropzone** `useDropzone` implementation — it returns
`{getRootProps, getInputProps, rootRef, inputRef, open}` and `getInputProps` emits:

```js
{ accept: E, multiple: s, type: `file`, tabIndex: -1,
  style: { border:0, clip:`rect(0, 0, 0, 0)`, clipPath:`inset(50%)`, height:`1px`,
           margin:`0 -1px -1px 0`, overflow:`hidden`, padding:0, position:`absolute`,
           width:`1px`, whiteSpace:`nowrap` }, onChange: …, onClick: … }
```

So there **is** a real native `<input type="file">` — visually hidden, `tabIndex:-1`, and with no
`id`, `name`, `aria-label` or associated `<label>`. Nearby UI strings confirm the widget:
`or drag and drop here`, `Attach`. Drag handlers (`onDragEnter/onDragOver/onDragLeave/onDrop`) live
on the **root div**, not the input.

Consequences for `detectFields.ts`:

- `detect.ts:8` — the whole detection gate is `doc.querySelector('input[type="file"]')`. It *will*
  match, but only once React has mounted the dropzone.
- `getSignal` (`detectFields.ts:19-42`) will return `''` for that input — no id, no wrapping
  `<label>`, no `aria-labelledby`, no `aria-label`, no `placeholder`, no `name`.
- `classify` (`detectFields.ts:103-107`) still yields `resume_upload`, because the file branch
  defaults to it. Good.
- `getRequired` (`detectFields.ts:55-62`) yields **`false`** — react-dropzone sets no `required`
  and no `aria-required`. Ashby's schema says the Resume field is required. So the
  "prefer the required one" logic in `pipeline.ts:122-124` and `content/index.ts:33-35` picks the
  fallback branch, and `unresolvedRequiredFields` under-reports.

### 4. `attachResumeFile`'s fake `dataTransfer` yields zero files on the drop path

`fillForm.ts:161-167`:

```ts
const dropzone = input.closest('[class*="drop"], [class*="drag"]') ?? input;
const dataTransfer = { files: fileList, items: { add: () => {} }, types: ['Files'] };
for (const type of ['dragenter', 'dragover', 'drop']) { … }
```

Ashby's bundle contains the minified `file-selector` `getDataTransferFiles`, which react-dropzone
calls for any event carrying a `dataTransfer`:

```js
function Xwe(e, t) {                        // (dataTransfer, eventType)
  if (e.items) {                            // truthy → takes this branch
    let n = Yj(e.items).filter(e => e.kind === `file`);
    return t === `drop` ? Jj(Xj(yield Promise.all(n.map(Zwe)))) : n;
  }
  return Jj(Yj(e.files).map(e => Gj(e)));   // never reached
}
function Yj(e) {                            // fromList
  if (e === null) return [];
  let t = [];
  for (let n = 0; n < e.length; n++) { t.push(e[n]); }
  return t;
}
```

djobi's `items` is `{ add: () => {} }` — truthy, so the `items` branch is taken; its `.length` is
`undefined`, so `0 < undefined` is false and `Yj` returns `[]`. The `files` array djobi carefully
built is **never read**. react-dropzone receives zero files.

Two further problems in the same function:

- `Object.defineProperty(input, 'files', …)` (`fillForm.ts:153-154`) is unnecessary in Chrome. The
  HTML Standard makes `files` settable —
  [§ common input element APIs](https://html.spec.whatwg.org/multipage/input.html#dom-input-files):
  "The `files` IDL attribute allows scripts to access the element's selected files… **On setting, it
  must run these steps**". The spec-correct, Chrome-supported route is
  `const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;`, which produces a
  genuine `FileList`. The comment at `fillForm.ts:144-150` asserting `DataTransfer` can't be used is
  incorrect for the production target; it is only true of jsdom, which is a test-environment
  constraint leaking into product code.
- The `closest('[class*="drop"], [class*="drag"]')` heuristic is a guess. Ashby uses hashed CSS-module
  class names, so it will likely miss and fall back to `input`. That is harmless in itself — the
  events bubble to the react-dropzone root regardless — but it means the `dropzone` variable is
  doing nothing.

The **change path** (`fillForm.ts:169`) is more promising: React routes `input[type=file]` through
`shouldUseChangeEvent`, so a bubbling `change` reaches react-dropzone's `onChange` with no tracker
gate, and `file-selector` then takes the `isChangeEvt` branch reading `evt.target.files`, which the
`Object.assign([file], …)` shim satisfies (it has a numeric `length`). But djobi fires the
zero-file `drop` **first** (`fillForm.ts:163-167`), so Ashby's `onDrop` runs with an empty accepted
*and* empty rejected list before the change arrives. Whether that leaves a sticky error/empty state
is not determinable statically — see "Unverified" below.

### 5. The Ashby API oracle is dead

`apiDetectors.ts:199-201` builds `https://api.ashbyhq.com/posting-api/job-posting/{jobId}` and
`apiDetectors.ts:213` POSTs to it. Live result:

```
POST https://api.ashbyhq.com/posting-api/job-posting/55d672a5-823b-4ad3-9e06-5c7f8aff529a → 401
```

`apiDetectors.ts:214` (`if (!res.ok) return fields;`) then silently returns the DOM-only fields.
The Ashby branch of `enrichWithApiOracle` (`apiDetectors.ts:418`) has never done anything.

The doc it was derived from,
[`developers.ashbyhq.com/reference/jobpostinginfo`](https://developers.ashbyhq.com/reference/jobpostinginfo),
is the **employer** API: `POST https://api.ashbyhq.com/jobPosting.info`, `"security": [{"BasicAuth": []}]`,
requiring the `jobsRead` permission. It is unusable from an extension.

Separately, the *unauthenticated* public board API does exist but carries no form schema. Live:
`GET https://api.ashbyhq.com/posting-api/job-board/outset` → 200, with `jobs[]` keys
`id, title, department, team, employmentType, location, secondaryLocations, publishedAt, isListed,
isRemote, workplaceType, address, jobUrl, applyUrl, descriptionHtml, descriptionPlain`. **No
`applicationFormDefinition`.** So the `AshbyJobResponse` interface at `apiDetectors.ts:165-167` does
not match anything Ashby serves publicly at any path. The only public source of the form schema is
the GraphQL endpoint documented in §3 above.

### 6. `"Name"` is unclassifiable

`detectFields.ts:81-92`:

```ts
['first_name', /first name|given name/i],
['last_name',  /last name|surname|family name/i],
['full_name',  /full name|legal name/i],
```

Ashby's required field is titled exactly `Name` (§3 table). None of these match, so
`classify` returns `'unknown'` (`detectFields.ts:114`), `valueForCategory` returns `undefined`
(`pipeline.ts:62-64`), and the candidate's name is never filled — even in a world where causes 1–3
are fixed. `docs/ats-platform-detection.md`'s Greenhouse section did not surface this because
Greenhouse splits into `first_name`/`last_name`.

### 7. Silent success

`pipeline.ts:153-158` computes `unresolvedRequiredFields` by filtering `jobPageData.fields`. When
that array is `[]` (cause 1), the result is `[]`. `App.tsx:514-519` then renders:

> ✅ Filled and application saved.

The user gets a green check for a fill that touched nothing. This is why the bug is hard to notice
and hard to report precisely.

---

## What is unverified / needs a live browser check

These require loading the page in a real Chrome with the extension installed; static analysis
cannot settle them.

1. **Whether Ashby's mount finishes inside the 10s watch window** (`detect.ts:29,43`), and whether the
   file input appears *before or after* the text inputs. If it appears first, `detectFields` snapshots
   a partial form and never re-runs (`detect.ts:38-39` disconnects the observer on first hit).
2. **Whether `data-djobi-id` attributes survive** to fill time. React does not strip unknown
   attributes it did not set, but if Ashby re-mounts the form subtree the tagged nodes are gone and
   `resolveField` (`fillForm.ts:9`) silently returns `null` for every field.
3. **How Ashby renders the four `Boolean` questions** — native `<fieldset>` + radios (handled by
   `detectFieldsetGroups`), a `role="combobox"` (handled), or custom buttons (**not** handled by any
   path in `detectFields.ts`).
4. **Whether the zero-file `drop` poisons react-dropzone's state** such that the subsequent `change`
   is ignored, or whether the change path succeeds anyway. Determines whether the upload is broken
   outright or merely fragile.
5. **react-dropzone's `accept` value** for this posting — if it validates by extension/MIME, confirm
   `resume.pdf` / `application/pdf` passes `pipeline.ts:128-131`.
6. **The `RejectBase64EncodedResumesFrontEnd` / `RejectBase64EncodedResumesThrowErrorFrontEnd`
   feature flags** are active in this org's `window.__appData`. Their effect on a programmatically
   attached `File` is unknown and worth checking against Ashby's submit path.
7. **Whether the internal GraphQL endpoint is stable/allowed.** It is unauthenticated today and
   introspection is disabled; it is an internal API with no compatibility guarantee.

---

## Recommended fixes

Ordered to match the ranking. Nothing below has been applied.

**F1 — Move `jobPageStore` to `chrome.storage.session`.** `apps/extension/src/background/jobPageStore.ts:8`.
Mirror `lib/pipelineRunStore.ts:61-69` exactly; that module already documents why. Make
`getJobPageData`/`setJobPageData` async and update the two call sites,
`router.ts:16,26,32` and `pipelineRunner.ts:59`. This is the single highest-value change.

**F2 — Don't let the background silently downgrade to `fields: []`.** `pipelineRunner.ts:59-63`.
Either have the panel send its `jobPageData.fields` with `START_ANALYSIS`
(`App.tsx:295-301`, `lib/messages.ts:26-32`), or make `runAnalysis` re-request a fresh scan from the
content script when the store misses, rather than writing an empty-field run. Also stop `App.tsx:292`
from being a local-only write.

**F3 — Use the native prototype setter in `fillForm`.** `fillForm.ts:138-140` and
`fillForm.ts:48-50`. Add a helper that resolves `Object.getOwnPropertyDescriptor(proto, 'value').set`
for `HTMLInputElement` / `HTMLTextAreaElement` / `HTMLSelectElement` and `.call(el, value)`. Add a
regression test that installs a React-style instance-level `value` accessor on the element to prove
the tracker sees the change — the current jsdom tests
(`fillForm.test.ts`) cannot fail on this.

**F4 — Rewrite `attachResumeFile` around a real `DataTransfer`.** `fillForm.ts:152-170`. Use
`new DataTransfer()` + `dt.items.add(file)` + `input.files = dt.files` (spec-sanctioned, see §4),
falling back to the current shim only when `DataTransfer` is absent (jsdom). Dispatch a real
`DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })` — a genuine
`DataTransferItemList` makes `file-selector`'s `items` branch work instead of returning `[]`.
Consider firing `change` **before** `drop`, or dropping the drag sequence entirely once the change
path is confirmed working, since Ashby's react-dropzone handles both.

**F5 — Add re-detection.** `detect.ts:31-52` and `content/index.ts:14-20`. Either keep the
`MutationObserver` alive (debounced) and re-report on change, or add an explicit "re-scan page"
action to the panel that the user can hit before **Fill form**. Cause 4 is otherwise unfixable for
any client-rendered ATS.

**F6 — Replace the Ashby oracle.** `apiDetectors.ts:199-221`. Point it at
`POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` with the query in §3, and
change `AshbyJobResponse` (`apiDetectors.ts:159-167`) to
`applicationForm.sections[].fieldEntries[].{field:{title,type,selectableValues},isRequired}`. Add
`https://jobs.ashbyhq.com/*` to `host_permissions` (`manifest.ts:48-54`) — the current list only
covers `api.ashbyhq.com`. Note `parseAshbyUrl` (`apiDetectors.ts:143-157`) already yields
`orgName: "outset"`, which the query needs as `organizationHostedJobsPageName`. Given §5,
seriously consider whether the oracle should *supply* fields rather than merely enrich DOM-scraped
ones — Ashby's schema is complete and authoritative, and `docs/ats-platform-detection.md` already
argues for an API-first strategy here.

**F7 — Add a bare-name rule.** `detectFields.ts:81-92`. Append `['full_name', /^\s*name\s*$/i]`
*after* the existing first/last/full rules so it only catches an otherwise-unmatched bare "Name".

**F8 — Make empty fills loud.** `pipeline.ts:153-158`. If `jobPageData.fields.length === 0`, or if
no value was written for any field, surface that as a distinct state rather than letting
`App.tsx:514-519` render success. A "filled 0 of 0 fields" run should never show a green check.
