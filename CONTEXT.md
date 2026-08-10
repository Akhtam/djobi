# djobi

A Chrome extension that autofills job applications on ATS platforms with an AI-tailored resume and drafted answers to freeform questions, backed by a local server and a persisted history of past applications.

## Language

### Application pipeline

**Application Pipeline**:
The end-to-end flow that turns a detected job page into a filled, saved Application — the Analysis Step followed by the Fill Step.
_Avoid_: autofill process, flow

**Analysis Step**:
Extracting structured Job Info from a scraped job page, then tailoring a Resume and drafting Question Answers from it.
_Avoid_: extraction (too narrow — covers only the first half)

**Fill Step**:
Turning Analysis Step results into a filled application: generating the Tailored Resume file, filling the page's form fields, attaching the resume, and saving the Application record.
_Avoid_: submission (the Application still ends up in `draft` status — nothing is sent to the employer by this step)

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
One fillable input, textarea, or select on a job application page, classified into a category (name, email, resume upload, question, etc.) by the field-detection heuristic.
_Avoid_: form field, input

**Application**:
One persisted record of an attempt to apply to a job — the Job Info, Tailored Resume, and Question Answers used, plus a status (`draft`/`submitted`) and, once interview tracking lands, a stage.
_Avoid_: job application (ambiguous with the act of applying itself)
