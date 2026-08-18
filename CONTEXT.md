# djobi

A Chrome extension that autofills job applications on ATS platforms with an AI-tailored resume and drafted answers to freeform questions, backed by a local server, a persisted history of past applications, and a Dashboard for tracking them afterwards.

## Language

### Application pipeline

**Application Pipeline**:
The end-to-end flow that turns a pasted Job Description plus a detected form into a filled, saved Application — the Analysis Step followed by the Fill Step.
_Avoid_: autofill process, flow

**Job Description**:
The job posting text, as the candidate pastes it into the panel. The Analysis Step's only input — the page itself is read for its form, never for the posting.
_Avoid_: page text, scraped text (both name a source that no longer exists)

**Analysis Step**:
Extracting structured Job Info from the pasted Job Description, then tailoring a Resume and drafting Question Answers from it.
_Avoid_: extraction (too narrow — covers only the first half)

**Fill Step**:
Turning Analysis Step results into a filled page: generating the Tailored Resume file, filling the page's form fields, and attaching the resume. It reports back only what the page verifiably kept.
_Avoid_: submission (nothing is sent to the employer by this step), saving (a separate, explicit step — see Save Step)

**Save Step**:
Recording a filled run as an Application, on an explicit action after the Fill Step. Creates the record the first time and updates that same record on every later save for the run, so re-filling or re-editing doesn't leave duplicates.
_Avoid_: submission (nothing is sent to the employer by this step — the candidate submits on the ATS themselves, and saves afterwards)

**Duplicate Guard**:
The check that runs before the Analysis Step: if an Application already exists for this exact job URL, the run stops at `duplicate` before any LLM call and the candidate is asked whether to proceed anyway. Fails open — a lookup that errors is treated as "no duplicates", because it exists to save the candidate from re-applying, not to gate their work.
_Avoid_: deduplication (nothing is merged or removed)

### Application data

**Profile**:
The user's base, job-independent information — contact details, links, work experience, education, skills, and stories — that seeds every Application.
_Avoid_: resume, CV

**Job Info**:
The structured facts extracted from a job posting — company, team, role title, seniority, requirements, keywords.
_Avoid_: job posting (the raw page/text), listing

**Tailored Resume**:
A resume reworded and reordered from the Profile to emphasize what's relevant to a specific Job Info. Never fabricates experience the Profile doesn't have.
_Avoid_: resume (ambiguous with the Profile's own experience data)

**Question Answer**:
A drafted answer to one freeform application question, generated from the Profile and Job Info. Always reviewed/edited by the user before the Fill Step uses it.
_Avoid_: response

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
One persisted record of an attempt to apply to a job — the Job Info, Tailored Resume, and Question Answers used, plus a Stage and a Notes log. Saving is a manual step the candidate takes after actually submitting, so a stored Application is a submitted one; there is no separate "was this sent" flag.
_Avoid_: job application (ambiguous with the act of applying itself)

**Stage**:
Where an Application has got to in the employer's interview pipeline: `applied` → `phone_screen` → `interviewing` → `rejected`. Defaults to `applied`, and is never null, so nothing downstream has to null-check it.
_Avoid_: status (there is no longer a separate status field — see Application), step

**Note**:
One timestamped, categorized entry (`technical` / `behavioral` / `general`) in an Application's notes log. Appended, never overwritten, so interview questions recorded against one Application stay usable as preparation for the next.
_Avoid_: comment, note field (there is no single overwritable text field)

### Tracking

**Dashboard**:
The web app where the candidate reviews saved Applications and tracks each one's Stage and Notes. A separate origin talking to the same backend, not an extension page — it needs no `chrome.*` API and no open ATS tab. Reads and edits what the Application Pipeline already saved; it never runs a step of that pipeline.
_Avoid_: admin, tracker page, extension dashboard (it is neither an extension surface nor an administrative one)

**In Progress**:
The Stages that mean an Application is still live — `phone_screen` and `interviewing`. A judgement about which Stages count, not something the Stage order can answer: `applied` is not in progress because nothing has come back yet, and `rejected` is over.
_Avoid_: active, open (both read as "not deleted")
