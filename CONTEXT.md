# djobi

A Chrome extension that autofills job applications on ATS platforms with an AI-tailored resume and drafted answers to freeform questions, backed by a local server, a persisted history of past applications, and a Dashboard for tracking them afterwards.

## Language

### Application pipeline

**Application Pipeline**:
The end-to-end flow that turns a candidate-reviewed Job Description plus a detected form into a filled, saved Application — the Analysis Step, Fill Step and explicit Save Step.
_Avoid_: autofill process, flow

**Job Description**:
The focused job posting text in Autofill's editable panel field. The candidate may paste it or explicitly scrape it from the active page; scraping prefers `JobPosting` structured data, then scores focused DOM candidates and excludes form/navigation boilerplate. The reviewed field value is the Analysis Step's only posting input. Its Job Context is retained across same-job ATS routes such as Ashby's Overview → Application transition.
_Avoid_: page text (the full page is never the Analysis Step input), raw scrape (the extractor fails closed instead of returning an unfiltered page)

**Analysis Step**:
Extracting structured Job Info from the reviewed Job Description, then tailoring a Resume and drafting Question Answers from it.
_Avoid_: extraction (too narrow — covers only the first half)

**Fill Step**:
Turning Analysis Step results into a filled page: generating the Tailored Resume file, filling the page's form fields, and attaching the resume. When the content script responds, it reports what the page verifiably kept; when no frame responds, attempted counts remain available but the outcome is explicitly unverified.
_Avoid_: submission (nothing is sent to the employer by this step), saving (a separate, explicit step — see Save Step)

**Save Step**:
Recording the current run snapshot as an Application, on an explicit action after the Fill Step. Creates the record the first time and updates that same record on every later save for the run, so re-filling or re-editing doesn't leave duplicates. It neither submits the employer's form nor proves that the candidate submitted it separately.
_Avoid_: submission (nothing is sent to the employer or verified by this step)

**Duplicate Guard**:
The check that runs before the Analysis Step: if an Application already exists for this job posting, the run stops at `duplicate` before any LLM call and the candidate is asked whether to proceed anyway. Matching is on the **Job Key** — the job's URL identity, not the raw URL — so a posting revisited through an ad link or from the `/apply` screen is still recognized. The notice reports the past application's Stage as well as its date, because a live process and a year-old rejection call for different decisions. Fails open — a lookup that errors is treated as "no duplicates", because it exists to save the candidate from re-applying, not to gate their work.
_Avoid_: deduplication (nothing is merged or removed)

**Autofill Tab**:
The panel's first flow: the Application Pipeline as the candidate drives it — paste or scrape a Job
Description, Analyze, review, Fill, Save. A module beside the Log Tab and Ask Tab rather than the
body of the panel shell, which owns only the Profile bootstrap, the tab switch and the hand-off to
the Ask Tab. It is the one tab that renders a run; the shell's single use of that run is the header
pill.
_Avoid_: the panel (the shell is not the flow), autofill mode

**Ask Tab**:
The panel's third flow: one conversation about one application question, grounded in the Profile
(and the run's Job Info when there is one). Asking cold — a question the detector missed, or one
from a form the extension can't see — and refining an answer the Analysis Step drafted are the same
conversation with a different starting state, so they are one tab, one route and one LLM module,
seeded differently. It never writes to the page: with a seed it writes back to the run's Question
Answer, without one it offers a copy button.
_Avoid_: chat tab (the surface is named for what the candidate does with it), refine mode (refining
is a starting state, not a mode)

**Log Tab**:
The panel's second flow, alongside the Application Pipeline: records an Application the candidate made _themselves_ — their own resume, or LinkedIn Easy Apply — so it lands in the same history. Deliberately not a step of the pipeline and not a mode toggle on it: it has no Detected Fields, page writes or pipeline run state. Its URL field follows the active tab until the candidate edits it. It extracts Job Info from a pasted Job Description and writes an Application with Application Source `manual`, running the same Duplicate Guard lookup first — warning, but never blocking.
_Avoid_: manual mode, log mode (it is a tab; a mode would imply the pipeline has two meanings)

**Run Notice**:
One thing a pipeline run has to tell the candidate — that this posting is already applied to, that
the Analysis Step failed, how the Fill Step went, that the page kept nothing it was given. Derived
from the run rather than stored on it, and it lives only as long as the run does. A Run Notice names
the _situation_ and carries what its wording has to interpolate; the wording itself belongs beside
the surface that renders it, because the difference between "reload the page" and "fill it in by
hand" is a judgement about which problem to send the candidate after. More than one can stand at
once: an Application saved with required fields still unresolved reports both, since saving did not
fill them.
_Avoid_: Note (an Application's persisted interview-log entry — a different thing with a nearly
identical name), banner, alert (both name the pixels rather than the meaning)

### Application data

**Profile**:
The user's base, job-independent information — contact details, links, work experience, education,
skills, and stories — that seeds every Application. A work role keeps an uncapped Bullet Bank;
starred bullets must appear verbatim on every Tailored Resume, while the Profile's default bullet cap
and an optional role override bound the model's remaining selection.
_Avoid_: resume, CV

**Job Info**:
The structured facts extracted from a job posting — company, team, role title, seniority, requirements, keywords.
_Avoid_: job posting (the raw page/text), listing

**Tailored Resume**:
The resume shape an Application stores — the Profile's complete skills list unchanged, plus work
experience. On an `autofill` Application its work-experience bullets are a capped selection from each
role's Bullet Bank, reordered and possibly reworded to emphasize what's relevant to a specific Job
Info; starred bullets are always present verbatim, and the model can never fabricate experience the
Profile doesn't have. On a `manual` one it holds the complete Base Resume instead, uncapped and
untailored — which is why the Dashboard relabels it there rather than making a claim that isn't true
of the row.
_Avoid_: resume (ambiguous with the Profile's own experience data)

**Base Resume**:
The Profile projected straight into the Tailored Resume shape, nothing reworded — `baseResumeOf` in `@djobi/shared`. What a Log Tab entry stores in place of a Tailored Resume, since the candidate applied with their own resume and no model wrote anything.
_Avoid_: untailored resume (fine as UI copy, but it names the concept by what it isn't)

**Question Answer**:
A drafted answer to one freeform application question, generated from the Profile and Job Info. Always reviewed/edited by the user before the Fill Step uses it.
_Avoid_: response

**Keyword Coverage**:
What the Tailored Resume evidences of a Job Info's `keywords`, computed without a model: each
keyword is reported as evidenced in skills, evidenced in experience (with the bullet that carries
it), evidenced only by a Profile bullet absent from this resume (with that source bullet), or not
evidenced anywhere. A **report the candidate acts on, never an instruction fed back to the model**:
Profile-only evidence is worth starring, while a true gap is added only if the candidate has it.
Matching is whole-word, by the same rule that keeps a stored "No" out of "Norway".
_Avoid_: match score, ATS score (both name it as a number to maximize, which is what invites
keyword stuffing), keyword match rate

**Importance Band**:
How much one of a posting's requirements matters _in that posting_ — one of `critical`, `high`,
`meaningful`, `preferred`, `low-signal`, or null when nothing assessed it. Never a claim about the
candidate, and never a number: five bands, because the evidence cannot support finer grain and a
figure would invite arithmetic (summing weight, "% of importance matched") nobody has licensed.
Paired with an **Importance Tier** — `stated`, `structural` or `inferred` — saying where the band
came from, and a **Posting Signal**: the posting's own wording the band rests on, and gated by one rule: an `inferred` band can never be `critical` or `high`, so every
band a reader acts on rests on the posting's own words or layout rather than on market guesswork.
Distinct from a requirement's `kind`, which records how the posting _phrased_ it.
_Avoid_: requirement score, priority score, weight (all name it as a number to maximize or to do
arithmetic with)

**Detected Field**:
One thing on a job application page a candidate fills in, classified into a category (name, email, resume upload, question, etc.) by the field-detection heuristic. Usually one input, textarea or select — but a whole group of choices answering a single question (a fieldset, a `role="radiogroup"`, or radios sharing a `name`) is _one_ Detected Field, with the choices as its options.
_Avoid_: form field, input (both suggest a single element, which a choice group isn't)

**Board Token**:
The identifier an ATS keys its own job board by — Greenhouse's `brex` in
`boards-api.greenhouse.io/v1/boards/brex/jobs/{id}`. Stated outright by a URL on the ATS's own host,
and _guessed from the company's hostname_ on a white-labeled board, where the page carries the
Posting Id but never the token.
_Avoid_: board id (it is not the board's numeric id), company slug

**Posting Id**:
The ATS's own numeric id for one job posting — the `gh_jid` parameter, or the `/jobs/{id}` path
segment. Together with a Board Token it addresses a posting's schema; alone it addresses nothing.
_Avoid_: job id (ambiguous with the Application's own id), requisition id (the employer's separate
internal reference, e.g. `JR101359`)

**Application**:
One persisted record of an attempt to apply to a job — the saved Job Info, Tailored Resume, and Question Answers, plus a Stage and a Notes log. There is no draft/submitted status or separate "was this sent" flag, and the act of saving does not prove employer submission.
_Avoid_: job application (ambiguous with the act of applying itself)

**Application Source**:
How an Application came to exist: `autofill` (the Application Pipeline produced it) or `manual` (the candidate applied by hand and recorded it through the Log Tab). Defaults to `autofill`, so every row written before the field existed — and the extension's unchanged save path — stays valid. Never part of an Application's editable snapshot: provenance is a fact about the record, so a re-save must not be able to relabel it.
_Avoid_: type, kind, origin

**Stage**:
Where an Application has got to in the employer's interview pipeline: `applied` → `phone_screen` → `onsite` → `offer` → `rejected`. Defaults to `applied`, and is never null, so nothing downstream has to null-check it.
_Avoid_: status (there is no longer a separate status field — see Application), step

**Note**:
One timestamped, categorized entry (`technical` / `behavioral` / `general`) in an Application's notes log. Appended, never overwritten, so interview questions recorded against one Application stay usable as preparation for the next. A candidate may **delete** one — behind a confirmation, and never in bulk — but may not edit it: a note rewritten in place is history that can no longer be trusted, while a note removed is one the candidate has said never belonged in the log. "Never overwritten" is a rule about concurrent writes not losing each other, not a claim that entries are permanent.
_Avoid_: comment, note field (there is no single overwritable text field), immutable (removal is offered; editing is not)

### Tracking

**Dashboard**:
The web app where the candidate reviews saved Applications and tracks each one's Stage and Notes. A separate origin talking to the same backend, not an extension page — it needs no `chrome.*` API and no open ATS tab. Reads and edits what the Application Pipeline or Log Tab already saved; it never runs a step of that pipeline.
_Avoid_: admin, tracker page, extension dashboard (it is neither an extension surface nor an administrative one)

**In Progress**:
The Stages that mean an Application is still live — `phone_screen`, `onsite`, and `offer`. A judgement about which Stages count, not something the Stage order can answer: `applied` is not in progress because nothing has come back yet, and `rejected` is over.
_Avoid_: active, open (both read as "not deleted")
