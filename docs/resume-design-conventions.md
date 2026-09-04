# Resume design conventions — research for `renderResume.ts`

> **Status: implemented (updated 2026-09-04).** The typography recommendations below were
> mostly applied to `apps/backend/src/pdf/renderResume.ts`, which also gained a one-page fitting
> ladder built on the sourced ranges. PDF preflight later added A4/Letter selection, embedded Noto
> Sans for Unicode text, and made the literal `Role: ` prefix a profile preference that defaults on.
> This doc
> is kept as the **record of where the numbers came from** — every "current state" note and the
> summary comparison describe the code _before_ that pass, not today's. Read it as research history,
> not as a to-do list.
>
> **The rendering library changed on 2026-09-04**, from `@react-pdf/renderer` to `@libpdf/core`, so
> that the renderer can run in a Cloudflare Worker (react-pdf reads font files off disk and its Yoga
> layout engine instantiates WebAssembly at runtime — a Worker permits neither). **Every number in
> this doc survived that change unaltered**; they are typographic decisions, not library settings.
> What changed is how they are applied: what was a `StyleSheet` of flexbox rules is now explicit
> cursor arithmetic in `ResumeLayout`. The two renderer-specific claims below — that text extracts
> as text rather than vector paths, and that `letterSpacing` does not corrupt the text stream — were
> **re-verified against the new renderer** and still hold; each now has a test pinning it.

## Why this doc exists

When this research was written, `apps/backend/src/pdf/renderResume.tsx:5-21` held a
`StyleSheet.create` block whose values (`padding: 32`, `fontSize: 10`, no explicit `lineHeight`,
`borderBottom: 1` under section titles, `fontSize: 18` name) had been chosen by eye, not against any
source. The implementation has since changed. This doc collects what **primary sources** — ATS
vendor help centres, typographic references, and university career-centre style guides — said so
the resulting numbers can be defended or changed deliberately.

Constraints the recommendations must respect, from
[react-pdf.org/styling](https://react-pdf.org/styling) and [react-pdf.org/fonts](https://react-pdf.org/fonts)
(both fetched):

- **No CSS grid.** Flexbox only (`flexDirection`, `justifyContent`, `alignItems`, `flexWrap`, `gap`).
- **Units**: `pt` is the default for bare numbers; `in`, `mm`, `cm`, `%`, `vw`, `vh` also accepted.
- **Supported text props**: `fontSize`, `fontFamily`, `fontStyle`, `fontWeight`, `lineHeight`,
  `letterSpacing`, `textAlign`, `textDecoration`, `textTransform`. `lineHeight` is a unitless
  multiplier of `fontSize`.
- **Built-in fonts** (no `Font.register` needed): `Courier`/`-Bold`/`-Oblique`/`-BoldOblique`,
  `Helvetica`/`-Bold`/`-Oblique`/`-BoldOblique`, `Times-Roman`/`Times-Bold`/`Times-Italic`/`Times-BoldItalic`.
  The docs note react-pdf "cannot ship a wide amount of them." **Bold and oblique are separate font
  names, not weights** — `fontWeight: 'bold'` at `renderResume.tsx:15` works only because react-pdf
  maps it onto `Helvetica-Bold`; `fontFamily: 'Helvetica-Bold'` is the unambiguous form.
- A4 is **595 × 842 pt** (1 inch = 72 pt, so 0.5″ = 36 pt, 0.75″ = 54 pt, 1″ = 72 pt).

**Verification note.** Every claim below is tagged with how it was obtained. "Fetched" means the
cited URL was retrieved this session and the wording comes from it. Where only listicles/marketing
blogs could be found, that is stated explicitly as **folklore** rather than dressed up.

---

## 1. Margins

| Source                                                                                                                                                                                                 | Recommendation                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Harvard Griffin GSAS Master's Resume & Cover Letter Guide (2025 PDF, fetched)](https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2025/08/MASTERS-RESUME-COVER-LETTER-GUIDE.pdf) | "Margins should be equal all the way around the page and should be at least three quarters of an inch in size." → **≥ 54 pt, equal on all sides**                                                                                                                        |
| [Stanford BEAM "Brief Resume Guide" (PDF, fetched)](https://careered.stanford.edu/sites/g/files/sbiybj22801/files/media/file/developing_your_resume_handout.pdf)                                       | "0.75-1.0 margins (top and bottom margin can be .5)" → **54–72 pt sides, 36 pt top/bottom floor**                                                                                                                                                                        |
| [MIT CAPD resume checklist (fetched)](https://capd.mit.edu/resources/resume-checklist/)                                                                                                                | "Are the margins consistent and between 0.5 and 1.0 inches?" → **36–72 pt**                                                                                                                                                                                              |
| [MIT CAPD career toolkit (fetched)](https://capd.mit.edu/resources/career-toolkit-crafting-an-effective-resume/)                                                                                       | "keep margins at least 0.5 inches, ideally 0.75 inches"                                                                                                                                                                                                                  |
| [Butterick, _Page margins_ (fetched)](https://practicaltypography.com/page-margins.html)                                                                                                               | "At 12 point, left and right page margins of 1.5–2.0″ will usually give you a comfortable line length" — but explicitly not a rule: margins exist to control line length, and "The smaller the point size, the larger the page margins will need to be, and vice versa." |

**Where they disagree.** The floor is genuinely disputed: MIT says 0.5″ (36 pt) is acceptable,
Harvard says nothing below 0.75″ (54 pt), Stanford splits the difference (0.75″ sides, 0.5″ top/bottom
allowed). **The defensible range is 36–72 pt; 36 pt is the absolute floor and only MIT endorses it.**

Butterick is in a different universe (1.5–2.0″ at 12 pt) because he is optimising for a reading
document, not a one-page scan document — see §4.

**Print risk.** No primary source found for the widely-repeated claim that margins below 0.5″ get
clipped by printers. Consumer laser/inkjet printers do have a non-printable edge (typically ~0.16–0.25″),
which is well inside 36 pt (0.5″), so 36 pt is safe in practice — but treat the specific "0.5 inch or
it gets cut off" number as **folklore**; no vendor documentation for it was located.

**Parsing risk from margins: none found.** No ATS vendor doc consulted (Greenhouse, Workday, Oracle
Taleo) mentions margins at all. Parsers work on the extracted text stream, not the page box.

**Pre-implementation state:** `renderResume.tsx:6` used `padding: 32` — **below every source's
floor** (32 pt = 0.44″).

---

## 2. Body font size

| Source                                                                               | Recommendation                                                                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [Butterick, _Point size_ (fetched)](https://practicaltypography.com/point-size.html) | "In print, the op­ti­mal point size for body text is 10–12 point."                                               |
| Harvard Griffin GSAS guide (fetched)                                                 | "Font size should be between 10 and 12 point and kept consistent throughout the document."                       |
| Stanford BEAM (fetched)                                                              | "Use 10-12 font size (for smaller fonts such as Times New Roman – use 11-12 font size)"                          |
| MIT CAPD checklist (fetched)                                                         | "Is your font size between 10 pt and 12 pt?"                                                                     |
| MIT CAPD career toolkit (fetched)                                                    | Warns against shrinking font to fit: "if a recruiter can't easily read your font, they may just skip reading it" |

**Consensus is unusually strong: 10–12 pt, and 10 pt is the floor.** Four independent sources agree
on the exact same bracket. Stanford adds a font-specific caveat: narrower/smaller-on-the-body faces
(Times) should go 11–12 pt, while a larger-x-height sans (Helvetica/Arial) is fine at 10.

**ATS parsing floor: no primary source exists.** No ATS vendor documents a minimum font size.
Greenhouse's parse-failure article names spacing/graphics/columns but never point size. **The claim
that "ATS can't read below 10pt" is folklore** — parsers read the PDF text stream, where the glyph
point size is metadata. What _is_ documented (Greenhouse, below) is that _letterspaced_ text breaks
parsing, which is a different failure mode.

Since `renderResume.tsx` uses Helvetica, **10 pt is legitimate and 10.5 pt is the safer default**;
9 pt is outside every guide.

---

## 3. Line height / leading

| Source                                                                                   | Recommendation                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Butterick, _Line spacing_ (fetched)](https://practicaltypography.com/line-spacing.html) | "between 120% and 145% of the point size". Single-spacing (~117%) is too tight; double (~233%) far too loose. |

This is the only primary typographic source with a number. None of the three career centres specify
leading — they talk about "white space" qualitatively (§9).

**→ `lineHeight: 1.2` to `1.45`.** At 10 pt body that is 12–14.5 pt per line.

**Pre-implementation state:** `renderResume.tsx` set no `lineHeight` at all, so react-pdf applied its
own default (approximately the font's built-in line gap, roughly 1.15–1.2 for Helvetica) — i.e. at
or just below the bottom of Butterick's range, the "too tight" end.

---

## 4. Line length — and the honest conflict with A4

[Butterick, _Line length_ (fetched)](https://practicaltypography.com/line-length.html): the ideal is
**45–90 characters per line, including spaces**, and "characters per line works at any point size."

**Measured against real font metrics.** Rather than estimate, average character advance was measured
with the exact PDF engine react-pdf uses (`@react-pdf/pdfkit@5.1.1`, resolved from this repo's
`node_modules`), using `widthOfString` on a representative resume bullet:

| Font        | Size | Avg char width | cpl @ 515 pt column (padding 40) | cpl @ 499 pt (padding 48) | cpl @ 487 pt (padding 54 = ¾″) |
| ----------- | ---- | -------------- | -------------------------------- | ------------------------- | ------------------------------ |
| Helvetica   | 10   | 4.55 pt        | 113                              | 110                       | 107                            |
| Helvetica   | 10.5 | 4.78 pt        | 108                              | 104                       | 102                            |
| Helvetica   | 11   | 5.01 pt        | 103                              | 100                       | 97                             |
| Times-Roman | 10   | 4.09 pt        | 126                              | 122                       | 119                            |
| Times-Roman | 11   | 4.50 pt        | 115                              | 111                       | 108                            |

**Conclusion, stated plainly: a single-column A4 resume cannot satisfy Butterick's 45–90 cpl rule at
any margin a career centre would endorse.** To hit 90 cpl in Helvetica 10 pt you need a ~410 pt text
column, i.e. **92 pt (1.28″) side margins** — wider than every career-centre maximum, and it would
cost roughly 20% of the horizontal content area, working directly against the ≥85% fill goal (§9).

The two guidances are optimising for different things and both are right within their domain:

- Butterick's 45–90 cpl protects **return sweep** — the eye finding the start of the next line across
  many consecutive lines of continuous prose.
- A resume is not continuous prose. Career-centre guidance is that bullets should be short: Stanford
  BEAM specifies "3-4 bullet points of no more than 2 lines each." **At 1–2 lines per bullet there is
  almost no return sweep to protect**, so the cost of a long measure is far lower than in a book.

**Practical resolution.** Accept ~100–110 cpl for bullets, and mitigate structurally rather than with
margins: keep bullets to ≤2 rendered lines, indent bullet text so its measure is slightly shorter than
full width, and use the largest body size the density budget allows (a larger size lowers cpl at fixed
column width — 10.5 pt buys ~6 fewer characters per line than 10 pt).

---

## 5. Type scale — name and headings vs body

| Source                                                                                                                                                        | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Butterick, _Headings_ (fetched)](https://practicaltypography.com/headings.html)                                                                              | "Use the smallest increment necessary to make a visible difference" — if body is 12 pt, try **12.5 or 13**, not 14–15. Bold is optional and can even come with a **0.5–1 pt reduction**. Avoid all caps, Title Case, underlining, and centering. **"The best way to emphasize a heading is by putting space above and below, because it's both subtle and effective."** Max three heading levels, ideally two. |
| [Butterick, _Bold or italic_ (fetched)](https://practicaltypography.com/bold-or-italic.html)                                                                  | "Bold **or** italic—think of them as mutually exclusive"; "if everything is emphasized, then nothing is emphasized." For **sans serif faces specifically: "skip italic and use bold for emphasis."**                                                                                                                                                                                                           |
| [Stanford Law, _Building Your Resume_ (search-surfaced)](https://law.stanford.edu/careers/getting-the-job/sample-application-materials/building-your-resume/) | "Your name in larger, darker font."                                                                                                                                                                                                                                                                                                                                                                            |
| Harvard Griffin GSAS guide (fetched)                                                                                                                          | Its own sample resumes render the name and section headings (`EDUCATION`, `RELEVANT PROFESSIONAL EXPERIENCE`) in **bold all-caps**, and the guide elsewhere endorses "bold, ALL CAPS, and white space to create a crisp professional style."                                                                                                                                                                   |

**No source gives a numeric ratio for the name.** The commonly quoted "name should be 1.5–2× body"
has **no primary source** — flag as folklore. What is documented is directional only ("larger,
darker").

**Genuine disagreement, worth naming.** Butterick says avoid all-caps headings and use the smallest
size increment. Harvard's guide explicitly endorses ALL CAPS for headings. This is a real conflict,
and the resume genre convention (all-caps section headings) is on Harvard's side. The reconciliation
that satisfies both: **use all caps + bold + letterspacing for section headings but keep the point
size increment tiny (0–0.5 pt over body)** — the caps and weight do the differentiating work, so
Butterick's "smallest increment" is honoured even though his caps advice is not. Butterick himself
concedes caps are acceptable "for headings under one line," which section headings are.

Derived scale for a 10 pt body:

- **Name: 16–18 pt (1.6–1.8×)** — the one place a large jump is justified, since it is the document's
  title and has no competitor on the page. Not sourced numerically; sourced only as "larger, darker."
- **Section heading: 10–11 pt (1.0–1.1×), bold, uppercase** — Butterick-compliant increment.
- **Entry company/title: 10 pt bold** — same size as body, weight alone.
- **Dates / contact line: 9–9.5 pt (0.9–0.95×)**, grey — de-emphasis, not emphasis.

---

## 6. Section order

**New grad / student — sources agree on education first.**

[MIT CAPD career toolkit (fetched)](https://capd.mit.edu/resources/career-toolkit-crafting-an-effective-resume/)
gives the explicit sequence: **1. Contact information (top) → 2. Education → 3. Experience (bulk of
the resume) → 4. Optional sections (awards, projects, activities, skills)**, with experience in
"reversed chronological order — most recent positions listed first."

Harvard's own sample master's resume (in the fetched 2025 GSAS PDF) follows exactly this:
name + contact on one line → `EDUCATION` → `RELEVANT PROFESSIONAL EXPERIENCE`.

**Experienced candidate — experience first, education demoted.**
[MIT CAPD checklist (fetched)](https://capd.mit.edu/resources/resume-checklist/) states the governing
principle rather than a fixed order: **"Are sections listed in order of importance to the employer?"**
Stanford BEAM likewise treats headings as candidate-chosen and descriptive ("Research Experience,
Teaching Experience, Leadership Experience"), not a fixed template. Harvard's careers blog on
certifications states they belong "below your work experience but above education," which places
education last for a non-entry-level candidate.

**ATS vendors do not prescribe an order, but they do prescribe _standard headings_.** Workday's admin
guide (fetched, below) states "Resume parsing results can vary based on resume format and **order of
words**," and Greenhouse's parse-failure article lists resumes lacking "clear sections" as a failure
cause. The actionable rule is therefore: **use conventional section names** (`Experience`,
`Education`, `Skills`) rather than creative ones, regardless of order.

**Recommendation for this codebase.** The current order at `renderResume.tsx:54-89` is
Skills → Experience → Education. That is defensible for an experienced tech candidate (skills block
front-loads keywords for both the parser and a 6–10 second human scan — MIT CAPD notes recruiters
spend "six to ten seconds reviewing a resume"). It is **wrong for a new grad**, where Education
should precede Experience. Since the renderer receives a `Profile`, this could be a data-driven
switch, but no primary source supports a specific years-of-experience threshold — that number is
folklore, so if a threshold is implemented, treat it as a product choice, not a sourced one.

---

## 7. What actively breaks ATS parsing

Only claims traceable to the vendor's own documentation are listed as confirmed.

### Greenhouse — the most explicit vendor source

[Unsuccessful resume parse (fetched)](https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse)
names these formatting causes verbatim:

- **"A columned layout"** — multi-column confirmed as a parse breaker.
- **"Complex resumes with tables, headers, and footers"** — tables and page headers/footers confirmed.
- **"Resumes with the name and contact information in the header, footer, or text box"** — text boxes
  confirmed; contact info specifically must be in the body flow.
- **Resumes containing "graphics, photos, or word art"** — confirmed.
- **Documents "uploaded as an image, rather than a document"** — flattened/scanned resumes confirmed.
- **"A resume with spaces between the letters. While it may appear cohesive to the naked eye, the
  parser won't recognize the separate letters as a single word"** — **this is the letterspacing
  hazard, and it is directly relevant to `letterSpacing` in react-pdf** (see below).
- Resumes lacking "clear sections and differing formats throughout".
- **"Incomplete job titles. For example, Sr. Account Exec instead of Senior Account Executive"**.
- File size: "Greenhouse Recruiting can't parse resumes larger than 2.5MB" (note: the separate
  [supported formats article, fetched](https://support.greenhouse.io/hc/en-us/articles/360052218132-Supported-formats-for-resumes-cover-letters-and-other-candidate-uploads)
  allows uploads "up to 100 MB" — the 2.5 MB limit is the _parsing_ ceiling, the 100 MB is the
  _upload_ ceiling. Both are true; they govern different steps).
- Supported formats: **".doc, .docx, .pdf, .rtf, .txt"**.

### Workday — official admin guide

[Concept: Resume Parsing, Workday admin guide (fetched)](https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/candidates/set-up-prospects-and-candidates/hdc1552497830785.html):

- **"For best results, use resumes that don't have images or image-based styles."** — images confirmed.
- **"Resume parsing results can vary based on resume format and order of words."**
- Notably, **Languages and Skills are _not_ auto-populated** by Workday's parser, and hidden fields
  are never populated.
- Workday's doc does **not** mention columns, tables, or headers. The widely-repeated claim that
  Workday reads two-column PDFs left-cell-then-right-cell is **only found in resume-tool blogs**
  ([tealhq.com](https://www.tealhq.com/post/workday-resume), resumeoptimizerpro.com, applyarc.com) —
  it is mechanically plausible and matches Greenhouse's confirmed behaviour, but **is not confirmed
  by Workday and should be labelled folklore-with-corroboration, not vendor-confirmed.**

### Oracle Taleo

[Oracle Taleo docs (search-surfaced; see _Resumes in Image Formats_ and _Implementing Recruiting_)](https://docs.oracle.com/en/cloud/saas/readiness/hcm/24a/tale-24a/24A-tbe-wn-f32282.htm):
**"The resume will not be parsed when it is in an image format"** — PNG/JPEG uploads are accepted by
the TBE Career Center but not parsed. Taleo also enforces a much smaller size ceiling than Greenhouse
(documented at 100 KB, admin-configurable), and supports .doc/.docx/.wpd/.txt/.rtf/.html/.pdf/.xls/.odt.

### Lever

**Could not verify against the vendor's own words.** `help.lever.co`'s "Understanding Resume Parsing"
article ([URL](https://help.lever.co/hc/en-us/articles/20087345054749-Understanding-Resume-Parsing))
returns HTTP 200 but is a JavaScript-rendered Salesforce help centre — a raw fetch yields only the
loading shell, matching the SPA behaviour already documented for other vendors in
`docs/ats-platform-detection.md:228-232`. Every "Lever needs single-column, no tables" claim reachable
this session came from resume-tool blogs. **Treat Lever specifics as unverified**; the Greenhouse
list is the safe superset to design against.

### Ashby

No parsing-format documentation found on `developers.ashbyhq.com` or Ashby's help content. Ashby's own
product writing describes AI-assisted review reading resumes "the way a recruiter would," which if
accurate makes layout _less_ critical there — but this is marketing copy about a review feature, not
a parsing spec. **Unverified.**

### Text as vector paths — verified directly for this renderer

This is the one hazard that could plausibly come from the rendering library rather than the design.
It does not: the PDF produced by the current `renderResume.ts` was text-extracted with `unpdf`
(pdf.js) and returned clean, correctly ordered, selectable text including the `•` bullets:

```
"Akhtam Ismatov\nakhtam.ismatov@gmail.com · 415-937-4262 · ...\nSkills\n...\nExperience\nCheckr August 2022 – June 2024\nRole: Full-Stack Developer\n• Improved API response times by 75% ...\nEducation\n..."
```

**The renderer embeds real fonts and real text operators, not outlined paths**, and the
single-column flow extracts in the correct reading order. Confirmed directly, not from docs — and
re-confirmed after the move to `@libpdf/core`, which also embeds a real font program (subsetted to
the glyphs each resume uses) and emits ordinary text-showing operators.

### The `letterSpacing` hazard, specifically

Greenhouse's "spaces between the letters" failure is about _literal space characters_ between glyphs
(`R E S U M E`), which produces `R E S U M E` in the text stream. **PDF `letterSpacing` is different**:
it adjusts glyph advance via the Tc operator without inserting space characters, so the extracted
string stays `RESUME`. The extraction above is the evidence that this spacing does not corrupt the
text stream. `renderResume.ts` now emits that `Tc` operator directly (`ops.setCharSpacing`, reset to
`0` after each tracked run so it cannot leak onto the rest of the page), and
`renderResume.test.ts`'s "keeps tracked headings extractable as whole words" asserts both that
`SKILLS` comes back whole and that it does _not_ come back as `S K I L L S` — which is what
drawing the glyphs individually to fake the same look would produce. Still, **keep `letterSpacing`
small (≤1 pt)** — some extractors synthesise word breaks from horizontal gaps above a threshold, and
large tracking is the one way to trip that.

### Design rules this yields

| Rule                                                                                                                                                         | Confirmed by                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Single column, one linear flow                                                                                                                               | Greenhouse ("a columned layout")                                               |
| No `<Table>`-shaped layouts; a two-`Text` flex row (company left, dates right) is **not** a table and is fine — it is one text run per cell in a single flow | Greenhouse (tables)                                                            |
| Nothing in `fixed` page headers/footers — no name, contact, or page numbers                                                                                  | Greenhouse (headers/footers, text boxes)                                       |
| No images, logos, icons, `Svg`, rating bars                                                                                                                  | Greenhouse (graphics/photos/word art), Workday (images), Taleo (image formats) |
| Bullets: use `•` U+2022 (verified to extract cleanly) or `-`. Avoid decorative dingbats                                                                      | MIT CAPD: use standard bullets, avoid "unusual symbols or characters"          |
| Spell out job titles in full ("Senior Account Executive")                                                                                                    | Greenhouse (incomplete job titles)                                             |
| Conventional section headings                                                                                                                                | Greenhouse ("clear sections"), Workday ("order of words")                      |
| Keep file well under 2.5 MB                                                                                                                                  | Greenhouse                                                                     |

`renderResume.tsx` already satisfies all of these. The `flexDirection: 'row'` header at
`renderResume.tsx:14` is the only construct worth a second look, and it is safe: it renders two
independent text runs, not a table grid, and the extraction test above shows them concatenating in
reading order on one line.

One content-level change considered by the research was removing `Role: ` from
`Role: {job.title}`. The concern was that the non-standard prefix might be swallowed into the title
string by a title-extracting parser. **This recommendation was rejected and not applied**; the
current renderer intentionally retains the literal prefix.

---

## 8. Emphasis and hierarchy without decoration

Ranked by what the primary sources actually endorse:

1. **Whitespace above/below.** Butterick, _Headings_: "The best way to emphasize a heading is by
   putting space above and below, because it's both subtle and effective." He adds that
   [space below should be smaller than space above](https://practicaltypography.com/space-above-and-below.html)
   "so the heading is visually closer to the text it introduces" — a directional rule with no number.
   Harvard's guide lists "white space" alongside bold and ALL CAPS as the three approved tools.
2. **Weight (bold).** Butterick, _Bold or italic_: for sans serif faces "skip italic and use bold for
   emphasis," because sans italics are too weak to read as emphasis. Since `renderResume.tsx` uses
   Helvetica, **`Helvetica-Oblique` is a poor emphasis tool here** — the current `jobRole` styling
   should stay roman or grey rather than becoming italic. Stanford BEAM: "Use bold font to highlight
   either your company or your title, whichever will be more impactful to your audience."
3. **All caps + letterspacing, for section headings only.** Butterick, _All caps_: caps work "for
   headings under one line, headers, footers, captions, and labels," and **"Always add letterspacing
   to caps to make them easier to read"** (he gives no amount — 0.5–1 pt at 10 pt is a reasonable
   reading of "add letterspacing," but the specific number is unsourced). Note the Butterick/Harvard
   conflict from §5.
4. **Size.** Smallest increment that reads as different (Butterick, _Headings_).
5. **Colour.** Not endorsed by any source; Harvard explicitly says "avoid text boxes, color, and
   shading." A **dark grey (#333–#444) for de-emphasis** of dates and the contact line is a
   defensible reading of "de-emphasis" rather than "color," but is not positively sourced.

**Underlining is rejected by every source consulted.** Butterick lists "Underlining anything" as
[typewriter habit #14](https://practicaltypography.com/typewriter-habits.html); Harvard's guide says
"avoid text boxes, underlining, and shading"; MIT's checklist asks whether you have "avoided
underlining."

**Horizontal rules under section headings.** [Butterick, _Rules and borders_ (fetched)](https://practicaltypography.com/rules-and-borders.html):
rules "are best used sparingly," and he asks "do you really need a rule or border to make a visual
distinction?" — recommending you **try spacing first**. Where a rule is used, he prescribes
**"the thickness between half a point and one point"**: thinner does not reproduce reliably on
printers or screens, thicker becomes visual noise. Stanford BEAM independently says "Avoid additional
formatting like lines, graphics, and italics — unless they help readability."

**Verdict for this renderer:** a full-width rule under each section heading is _defensible but not
required_; it earns its place only because it is doing genre-recognition work (it makes the section
boundary unmissable in a 6-second scan). If kept, **`borderBottomWidth: 0.75` sits in the middle of
Butterick's 0.5–1 pt window.** The current `borderBottom: 1` at `renderResume.tsx:9` is at the top of
that window and, as a shorthand, is less explicit than `borderBottomWidth` + `borderBottomColor`;
without a colour it renders black, which is heavier than the rule needs to be. A mid-grey rule
(`#999999`) at 0.75 pt reads as structure rather than as decoration. Rules do not affect parsing —
they are graphics operators, not text.

---

## 9. Density and whitespace — and the ≥85% fill goal

**This is the weakest-sourced area, and the one place a primary source argues against the stated goal.
Saying so plainly:**

- [Butterick, _Résumés_ (fetched)](https://practicaltypography.com/resumes.html) is the only primary
  typographic source specifically on resumes, and his single strongest claim is the **opposite** of a
  fill target: **"The biggest problem I see with résumés is that they're uncomfortably dense with
  text."** He also rejects the one-page rule — "Unless a potential employer demands one page, feel
  free to make your résumé longer, if necessary" — and recommends using a second page to _reduce_
  crowding, while keeping the critical information on page one.
- Harvard, MIT, and Stanford all treat one page as the norm (Harvard: "For BA/BS, MA/MS, and MBA
  candidates, a one-page resume is the norm"; MIT: "Have you kept it to one page? You may use two
  pages if you have an advanced degree or extensive experience (10+ years)"; Stanford: "1 – 2 page").
- All three career centres call for white space qualitatively and **none quantifies it**: MIT asks
  "Have you left enough white space to make it easy to read?"; Stanford says "White space helps people
  scan"; Harvard names white space as a formatting tool.

**No primary source states any page-fill percentage.** The "fill 85–90% of the page" heuristic appears
only in resume-builder marketing content. **It is folklore.** It is not _unreasonable_ folklore — a
one-page resume ending halfway down page one does read as thin, and the underlying instinct (don't
leave a half-empty page) is sound — but it must not be presented as sourced guidance.

**Where the goal and the sources actually conflict, and how to resolve it.** The conflict is real but
narrow. Butterick's complaint is about _typographic_ density — text set too tight to read (leading
below 120%, margins too small, size below 10 pt). The ≥85% goal is about _areal_ density — how much of
the page has content on it. **These are separable.** You can hit 85% areal fill while staying inside
every typographic floor, provided the fill comes from _content_ rather than from compression:

- ✅ Legitimate ways to reach 85%: more bullets, longer bullets, more roles, a skills line that wraps.
- ❌ Illegitimate ways: `fontSize` below 10, `lineHeight` below 1.2, padding below 36 pt, collapsing
  inter-section spacing to zero. Each of these violates a sourced floor to buy area.

**The budget, computed for A4.** With `paddingTop/Bottom: 40` the text block is 842 − 80 = **762 pt tall**.

- 85% of the **full page height** (842) = 715.7 pt of inked block → the content must run to within
  ~126 pt of the page bottom, i.e. fill 675.7 / 762 = **88.7% of the text block**.
- At 10 pt body with `lineHeight: 1.35`, one body line = **13.5 pt**. 762 / 13.5 ≈ **56 body lines**
  available; the 85% target needs ≈ **50 line-equivalents of content**.

Working that through the recommended stylesheet below (name 20.4 + 3, contact 12.2 + 14, three section
headings, two education entries):

- Fixed chrome (name, contact, three headings, education) ≈ **193 pt**
- Leaves ≈ **483 pt** for experience entries
- Each role costs ≈ 37 pt of chrome (top margin + company line + title line) + 16 pt per bullet

| Shape                 | Fits 85%?                               |
| --------------------- | --------------------------------------- |
| 3 roles × 7–8 bullets | ✅ ≈ 483 pt                             |
| 4 roles × 5 bullets   | ✅ ≈ 468 pt                             |
| 2 roles × 5 bullets   | ❌ ≈ 234 pt — page will look half-empty |

**So 85% is a content requirement before it is a layout one.** If the tailored resume has fewer than
roughly 20 total bullets across roles, no stylesheet can fill the page honestly, and the correct fix
is upstream (generate more/longer bullets in
`apps/backend/src/llm/tailorResume.ts`) rather than inflating leading and margins to fake it. If it
must be absorbed in layout, the sourced headroom is: `lineHeight` 1.35 → 1.45 (Butterick's ceiling),
padding 40 → 54 (Harvard's floor), section `marginTop` 14 → 18. That recovers roughly 60–80 pt of
vertical fill — enough for a modest shortfall, not a large one.

For the **overflow** direction (content spilling to page 2), the sourced headroom is the reverse and
is smaller: `lineHeight` 1.35 → 1.25, padding 40 → 36 (MIT's floor), section `marginTop` 14 → 10.
Below those, you are outside every source.

---

## Recommendation — a coherent minimal stylesheet

Every value below is inside the sourced ranges above. A4 = 595 × 842 pt.

```ts
const styles = StyleSheet.create({
  // Padding 40pt (0.56"): inside MIT's 0.5–1.0" range, below Harvard's 0.75" floor.
  // Horizontal 48pt keeps the measure at ~110 cpl (see §4) while preserving fill area.
  // lineHeight 1.35 sits mid-range of Butterick's 120–145%.
  page: {
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 48,
    fontSize: 10,
    lineHeight: 1.35,
    fontFamily: 'Helvetica',
    color: '#000000',
  },

  // 17pt = 1.7x body. "Larger, darker" (Stanford Law); the ratio itself is unsourced.
  // Tighter lineHeight because a single line needs no return-sweep leading.
  name: {
    fontSize: 17,
    fontFamily: 'Helvetica-Bold',
    lineHeight: 1.2,
    letterSpacing: 0.3,
    marginBottom: 3,
  },

  // 9pt = 0.9x body: de-emphasis. Grey rather than black; never in a page header (Greenhouse).
  contactLine: { fontSize: 9, color: '#333333', marginBottom: 14 },

  // 10.5pt = 1.05x body — Butterick's "smallest increment". Caps + bold + rule carry the hierarchy.
  // Rule at 0.75pt is mid-window of Butterick's 0.5–1pt. Grey so it reads as structure, not ink.
  // marginTop (14) > marginBottom (6): heading binds to the text below it.
  sectionTitle: {
    fontSize: 10.5,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    borderBottomWidth: 0.75,
    borderBottomColor: '#999999',
    paddingBottom: 2,
    marginTop: 14,
    marginBottom: 6,
  },
  // Apply to the first section only, so it doesn't double up with contactLine's marginBottom.
  sectionTitleFirst: { marginTop: 0 },

  skillsLine: {},

  // 9pt ≈ Butterick's 4–10pt / 50–100%-of-body paragraph spacing, at the top of that range,
  // because a role is a bigger unit than a paragraph.
  jobEntry: { marginTop: 9 },
  jobEntryFirst: { marginTop: 0 },

  jobHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  // Weight, not size, not italic — Helvetica's oblique is too weak for emphasis (Butterick).
  jobCompany: { fontFamily: 'Helvetica-Bold' },
  jobDates: { fontSize: 9.5, color: '#333333' },
  jobRole: { marginTop: 1 },

  // Hanging-indent look; the 11pt indent also shortens the measure slightly (§4).
  bullet: { marginLeft: 11, marginTop: 2.5 },

  educationEntry: { marginTop: 4 },
});
```

### Proposed diff against the pre-implementation file

| Style                       | Before                    | Recommended                           | Why                                                              |
| --------------------------- | ------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `page.padding`              | `32`                      | `40` v / `48` h                       | 32 pt = 0.44″, below MIT's 0.5″ floor and Harvard's 0.75″        |
| `page.lineHeight`           | _(unset, ≈1.15)_          | `1.35`                                | Below Butterick's 120% floor                                     |
| `name.fontSize`             | `18`                      | `17`                                  | Cosmetic; frees 1–2 pt and keeps the scale at 1.7×               |
| `name` weight               | _(regular)_               | `Helvetica-Bold`                      | The name is currently the only large-but-unbold element          |
| `sectionTitle.fontSize`     | `12` (1.2×)               | `10.5` (1.05×)                        | Butterick's smallest-increment rule; caps + bold do the work     |
| `sectionTitle` case         | mixed                     | `uppercase` + `letterSpacing: 0.8`    | Genre convention (Harvard); tracking per Butterick's caps rule   |
| `sectionTitle.borderBottom` | `1`, black                | `borderBottomWidth: 0.75`, `#999999`  | Mid-window of Butterick's 0.5–1 pt; grey reads as structure      |
| `sectionTitle.marginBottom` | `4`                       | `6`                                   | Heading needs to sit clear of its content                        |
| `jobEntry.marginTop`        | `12`                      | `9`                                   | Recovers ~9 pt over three roles toward the fill target           |
| `bullet.marginTop`          | `2`                       | `2.5`                                 | Slight separation at the higher leading                          |
| `Role: {job.title}` (`:69`) | literal `"Role: "` prefix | drop the prefix                       | Rejected/not applied; the current renderer retains the prefix    |
| first section / first entry | no special case           | `sectionTitleFirst` / `jobEntryFirst` | Avoids double spacing under `contactLine` and under each heading |

**Implementation outcome:** most of this table landed, with a density ladder replacing several
single fixed values. Unicode font support later changed Helvetica to the wider Noto Sans, so
horizontal padding is now 42 pt to prevent avoidable line wraps while remaining above the 36 pt
floor. The literal `Role: ` recommendation is now optional and defaults on.

### What is deliberately _not_ changed

- **Single column, no images, no fixed page header** — already correct, and confirmed safe against
  Greenhouse, Workday, and Taleo.
- **`•` U+2022 bullets** — verified to extract cleanly from this renderer's output.
- **`flexDirection: 'row'` job header** — not a table; extraction preserves reading order.
- **Section order (Skills → Experience → Education)** — defensible for an experienced candidate; would
  need to become Education-first for a new grad, but no source supports a specific threshold (§6).

### Open items

- **New-grad section order** is a product decision, not a sourced one. If implemented, document the
  threshold as a choice.
- **Lever's parsing constraints remain unverified** (JS-rendered help centre). The Greenhouse rule set
  is the safe superset in the meantime.
- **The 85% fill target is folklore.** It is compatible with every typographic source _provided_ the
  fill comes from content volume, not compression — and it should be enforced by generating enough
  bullets upstream, with layout adjustment only as a small last-resort trim (§9).
