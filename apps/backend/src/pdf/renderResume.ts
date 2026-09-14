import type { RenderResumePdfProfile, TailoredResume } from '@djobi/shared';
import { layoutText, ops, PDF, rgb, type EmbeddedFont } from '@libpdf/core';
import { notoSansBoldBase64, notoSansRegularBase64 } from './notoSansFonts.js';
import { preflightResumePdf } from './preflightResume.js';

/**
 * Decodes one of the base64 font blobs in `notoSansFonts.ts`.
 *
 * `atob` rather than `Buffer.from(..., 'base64')`: this module has to run unchanged in a Cloudflare
 * Worker, where `Buffer` exists only under `nodejs_compat`. `atob` is part of the standard library
 * in every environment this backend targets, so nothing here depends on the Node compatibility
 * layer being switched on.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Decoded once at module scope: the bytes are constant, and decoding ~0.4 MB per render would
// dominate a render that otherwise takes tens of milliseconds. Safe to do eagerly here because it
// reads no environment variable and touches no I/O — the two things that make module-scope work
// hostile to a Worker cold start (see `db/client.ts` for the case that does need laziness).
const NOTO_SANS_REGULAR = decodeBase64(notoSansRegularBase64);
const NOTO_SANS_BOLD = decodeBase64(notoSansBoldBase64);

/**
 * The layout, per `docs/resume-design-conventions.md` — every value here is inside a range some
 * primary source states, and the doc names which one. The short version of why these numbers and
 * not others:
 *
 * - **Hierarchy comes from weight, case, spacing and a hairline rule — never from size alone.**
 *   Section headings are only 1.05× body (Butterick's "smallest increment that works"); caps, bold
 *   and the rule carry the distinction. This is what keeps a minimal resume from looking like a
 *   ransom note of competing sizes.
 * - **Two floors this layout used to sit under.** `padding: 32` is 0.44", below MIT's 0.5" minimum;
 *   and no `lineHeight` at all left the renderer's ~1.15 default under Butterick's 120% floor. Both
 *   are readability floors, so both are raised here.
 * - **Nothing here fights the ATS.** Single column, no images, no repeated page header, `•` bullets
 *   that were verified to extract cleanly from this renderer. `letterSpacing` stays ≤1pt: it is
 *   applied with the PDF `Tc` operator, which moves glyph advance rather than inserting space
 *   characters, so `RESUME` still extracts as `RESUME` (asserted in `renderResume.test.ts`).
 */
/**
 * The knobs the one-page fit is allowed to turn, and nothing else.
 *
 * Every step below is inside a range `docs/resume-design-conventions.md` cites a source for, so a
 * compressed resume is still a *typographically legal* one — it is not the same page squeezed past
 * the point of readability. Sizes are deliberately absent: shrinking body text below 10pt is the
 * one compression every source rules out, so the fit may spend leading and whitespace but never
 * legibility.
 */
export interface Density {
  lineHeight: number;
  pagePaddingVertical: number;
  sectionGap: number;
  entryGap: number;
  bulletGap: number;
}

/**
 * Density steps, loosest first — the ladder {@link renderResumePdf} walks until the resume fits on
 * one page.
 *
 * The loosest step is the design as researched. The tightest sits on the floors the doc names
 * (leading 1.25 against Butterick's 120% minimum, 36pt padding against MIT's 0.5"): below it there
 * is no sourced room left, which is exactly why the ladder stops there rather than continuing to
 * shrink until something fits.
 */
export const DENSITY_STEPS: readonly [Density, ...Density[]] = [
  { lineHeight: 1.45, pagePaddingVertical: 40, sectionGap: 18, entryGap: 11, bulletGap: 2.5 },
  { lineHeight: 1.35, pagePaddingVertical: 40, sectionGap: 14, entryGap: 9, bulletGap: 2 },
  { lineHeight: 1.3, pagePaddingVertical: 38, sectionGap: 12, entryGap: 8, bulletGap: 1.5 },
  { lineHeight: 1.25, pagePaddingVertical: 36, sectionGap: 10, entryGap: 7, bulletGap: 1 },
];

/**
 * Page dimensions in points. Stated explicitly rather than via the library's `size: 'a4'` preset so
 * the numbers this layout is measured against live next to the layout itself.
 */
const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
} as const;

/**
 * Wider than the vertical padding: it shortens the measure toward the readable line length without
 * spending the vertical space the content needs. Noto Sans is wider than Helvetica; this remains
 * above the 36pt readability floor while keeping typical achievement bullets from gaining an
 * avoidable second line.
 */
const PAGE_PADDING_HORIZONTAL = 42;

const BODY_SIZE = 10;
const NAME_SIZE = 17;
const CONTACT_SIZE = 9;
const SECTION_TITLE_SIZE = 10.5;
const DATES_SIZE = 9.5;

/** Tighter than the body: a single line has no return sweep to leave room for. */
const NAME_LINE_HEIGHT = 1.2;

const NAME_LETTER_SPACING = 0.3;
const SECTION_TITLE_LETTER_SPACING = 0.8;

const BULLET_INDENT = 11;

const BLACK = rgb(0, 0, 0);
/** `#333333` — below body colour, for the one block a reader should skip until they need it. */
const GREY_TEXT = rgb(0.2, 0.2, 0.2);
/** `#999999` — the hairline under a section heading. */
const RULE_GREY = rgb(0.6, 0.6, 0.6);
const RULE_THICKNESS = 0.75;

interface TextStyle {
  font: EmbeddedFont;
  size: number;
  color?: ReturnType<typeof rgb>;
  /** Applied with the `Tc` operator; omitted (rather than `0`) when a style does not track. */
  letterSpacing?: number;
  /** Overrides the density's leading. Only the name sets this — see {@link NAME_LINE_HEIGHT}. */
  lineHeightMultiplier?: number;
}

/**
 * Lays a resume out top-down across as many pages as it needs.
 *
 * The cursor is measured **from the top of the page**, which is the direction the design is
 * specified in, and converted to PDF's bottom-left origin only at the moment of drawing. Doing it
 * the other way around leaves every margin in the layout expressed as a subtraction from the page
 * height, which is where sign errors live.
 *
 * Nothing here silently drops content when it runs out of room: overflowing starts a new page. That
 * is what lets {@link renderResumePdf} treat "it needed two pages" as a *measurable* outcome to
 * retry at a tighter density, rather than discovering it by finding text missing afterwards.
 */
class ResumeLayout {
  private readonly pdf: PDF;
  private readonly pageSize: { width: number; height: number };
  private readonly density: Density;
  private readonly regular: EmbeddedFont;
  private readonly bold: EmbeddedFont;
  private page: ReturnType<PDF['addPage']>;
  private pageCount = 1;
  /** Distance from the top of the current page to the top of the next thing drawn. */
  private y: number;

  constructor(
    pdf: PDF,
    pageSize: { width: number; height: number },
    density: Density,
    regular: EmbeddedFont,
    bold: EmbeddedFont,
  ) {
    this.pdf = pdf;
    this.pageSize = pageSize;
    this.density = density;
    this.regular = regular;
    this.bold = bold;
    this.page = this.pdf.addPage({ width: pageSize.width, height: pageSize.height });
    this.y = density.pagePaddingVertical;
  }

  private get contentWidth(): number {
    return this.pageSize.width - PAGE_PADDING_HORIZONTAL * 2;
  }

  private get bottomLimit(): number {
    return this.pageSize.height - this.density.pagePaddingVertical;
  }

  /** Vertical space one line of `size` occupies at the current density. */
  private lineHeightFor(size: number, multiplier?: number): number {
    return size * (multiplier ?? this.density.lineHeight);
  }

  /**
   * The baseline offset within a line box.
   *
   * Read from the font's own ascent rather than approximated as a fraction of the size, so the two
   * weights (which do not share an ascent) sit on the same baseline when they appear on one line —
   * the company/dates row is exactly that case.
   */
  private baselineOffset(font: EmbeddedFont, size: number): number {
    const ascent = font.descriptor?.ascent ?? 750;
    return (ascent / 1000) * size;
  }

  private startNewPage(): void {
    this.page = this.pdf.addPage({ width: this.pageSize.width, height: this.pageSize.height });
    this.pageCount += 1;
    this.y = this.density.pagePaddingVertical;
  }

  /** Adds vertical space, without letting a margin alone push past the bottom of a page. */
  advance(points: number): void {
    this.y += points;
  }

  /**
   * Draws one line of text at an absolute x, breaking to a new page first if it would not fit.
   *
   * `letterSpacing` is emitted as a bare `Tc` operator around the draw rather than by spacing the
   * glyphs out by hand. `Tc` is part of the PDF text state, so it changes glyph *advance* and
   * leaves the string in the content stream intact — which is what keeps `preflightResumePdf`'s
   * exact-text check passing over a tracked heading. Drawing character by character would space the
   * text visually and destroy it for every extractor, ATS included.
   */
  private drawLine(text: string, x: number, style: TextStyle, lineHeight: number): void {
    if (this.y + lineHeight > this.bottomLimit) this.startNewPage();

    const baselineFromTop = this.y + this.baselineOffset(style.font, style.size);
    const y = this.pageSize.height - baselineFromTop;

    if (style.letterSpacing) this.page.drawOperators([ops.setCharSpacing(style.letterSpacing)]);
    this.page.drawText(text, {
      x,
      y,
      font: style.font,
      size: style.size,
      color: style.color ?? BLACK,
    });
    // Reset rather than leave it set: `Tc` persists in the content stream, so an unreset value
    // silently tracks every subsequent run on the same page.
    if (style.letterSpacing) this.page.drawOperators([ops.setCharSpacing(0)]);

    this.y += lineHeight;
  }

  /**
   * The measure to hand `layoutText`, corrected for tracking.
   *
   * `layoutText` takes no letter-spacing argument, but `drawLine` emits `Tc`, which widens the run
   * it draws by `letterSpacing` per glyph. Wrapping to the raw measure therefore lets a tracked run
   * that *just* fits be drawn past the right margin — the name is the one tracked run long enough
   * to reach it, and at 0.3pt of tracking a 55-character name overflows by ~17pt. Shrinking the
   * measure by the tracking the whole string would add is exact for a run that does not wrap and
   * conservative for one that does, since each line then carries only its own share.
   */
  private wrapWidth(width: number, text: string, style: TextStyle): number {
    return width - (style.letterSpacing ?? 0) * text.length;
  }

  /**
   * Draws a paragraph, wrapping it to the content width.
   *
   * `layoutText` breaks on spaces and **keeps a word longer than the measure intact** rather than
   * splitting it mid-word. That is load-bearing, not incidental: a hyphenated break would put
   * `function-` / `ality` into the content stream, and `preflightResumePdf` compares extracted text
   * against the candidate's own words, so the render would fail its own integrity check. The
   * previous renderer needed an explicit hyphenation callback to get the same guarantee.
   */
  drawParagraph(text: string, style: TextStyle, indent = 0): void {
    const lineHeight = this.lineHeightFor(style.size, style.lineHeightMultiplier);
    const { lines } = layoutText(
      text,
      style.font,
      style.size,
      this.wrapWidth(this.contentWidth - indent, text, style),
      lineHeight,
    );

    for (const line of lines) {
      this.drawLine(line.text, PAGE_PADDING_HORIZONTAL + indent, style, lineHeight);
    }
  }

  /**
   * A row with one run pinned left and one pinned right — the company/dates header.
   *
   * This is the `flexDirection: 'row' / justifyContent: 'space-between'` the previous renderer got
   * from a layout engine, done as the one measurement it actually needs. The left run is wrapped to
   * whatever the right run leaves, so a long company name shortens rather than colliding with it.
   */
  drawSplitRow(left: string, leftStyle: TextStyle, right: string, rightStyle: TextStyle): void {
    const lineHeight = this.lineHeightFor(BODY_SIZE);
    const rightWidth = rightStyle.font.getTextWidth(right, rightStyle.size);
    const rightX = this.pageSize.width - PAGE_PADDING_HORIZONTAL - rightWidth;

    const available = this.wrapWidth(this.contentWidth - rightWidth - 8, left, leftStyle);
    const { lines } = layoutText(left, leftStyle.font, leftStyle.size, available, lineHeight);

    // Break before the row rather than inside it, so the header can never be split with the company
    // on one page and its dates on the next.
    if (this.y + lineHeight * lines.length > this.bottomLimit) this.startNewPage();

    // The left run is drawn **first**, because extraction follows content-stream order and
    // `preflightResumePdf` requires the company to read before its dates. Both share one baseline —
    // the row's first line — which is also what makes an extractor treat them as a single line
    // rather than two, so `Acme 2020-01 – Present` comes back as one run of text.
    const rowBaselineY =
      this.pageSize.height - (this.y + this.baselineOffset(rightStyle.font, rightStyle.size));

    for (const line of lines) {
      this.drawLine(line.text, PAGE_PADDING_HORIZONTAL, leftStyle, lineHeight);
    }

    this.page.drawText(right, {
      x: rightX,
      y: rowBaselineY,
      font: rightStyle.font,
      size: rightStyle.size,
      color: rightStyle.color ?? BLACK,
    });
  }

  /**
   * A section heading: tracked caps over a hairline rule.
   *
   * The heading's top margin is asymmetric by design — a heading belongs to what follows it, so it
   * sits nearer its own content than the section above.
   */
  drawSectionTitle(title: string, isFirst: boolean): void {
    if (!isFirst) this.advance(this.density.sectionGap);

    const style: TextStyle = {
      font: this.bold,
      size: SECTION_TITLE_SIZE,
      letterSpacing: SECTION_TITLE_LETTER_SPACING,
    };
    const lineHeight = this.lineHeightFor(SECTION_TITLE_SIZE);

    if (this.y + lineHeight + 8 > this.bottomLimit) this.startNewPage();
    this.drawLine(title.toUpperCase(), PAGE_PADDING_HORIZONTAL, style, lineHeight);

    // `paddingBottom: 2` in the old stylesheet — the gap between the caps and the rule.
    const ruleY = this.pageSize.height - (this.y + 2);
    this.page.drawLine({
      start: { x: PAGE_PADDING_HORIZONTAL, y: ruleY },
      end: { x: this.pageSize.width - PAGE_PADDING_HORIZONTAL, y: ruleY },
      color: RULE_GREY,
      thickness: RULE_THICKNESS,
    });
    this.advance(6);
  }

  async save(): Promise<{ bytes: Uint8Array; pages: number }> {
    // `subsetFonts` is not the default and matters enormously here: the two embedded faces are
    // ~0.4 MB together (already script-subsetted at generation time), and without subsetting every
    // one of those bytes is copied into every rendered resume. Subsetted, only the glyphs this
    // resume actually uses are written, which is the difference between a ~400 KB attachment and a
    // ~15 KB one.
    const bytes = await this.pdf.save({ subsetFonts: true });
    return { bytes, pages: this.pageCount };
  }

  bodyStyle(): TextStyle {
    return { font: this.regular, size: BODY_SIZE };
  }
}

/** Contact-info line: email, phone, location, and any non-null links, joined with ` · `. */
function contactLine(profile: RenderResumePdfProfile): string {
  return [
    profile.email,
    profile.phone,
    profile.location,
    profile.links.linkedin,
    profile.links.portfolio,
    profile.links.github,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

/**
 * Lays the whole resume out at one density and returns the bytes plus the page count it needed.
 *
 * Contact info and education come from the base `profile` (they don't need per-job tailoring);
 * skills and work experience come from `tailoredResume` (they do).
 */
async function renderAtDensity(
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
  density: Density,
): Promise<{ bytes: Uint8Array; pages: number }> {
  // One document — and so one pair of `EmbeddedFont`s — per pass. An `EmbeddedFont` accumulates the
  // glyphs it is asked to draw, and that record is exactly what `save({ subsetFonts: true })` writes
  // out. Sharing one across renders would grow every candidate's subset to the union of everyone's,
  // leaking one candidate's alphabet into the next one's file.
  const pdf = PDF.create();
  const regular = await pdf.embedFont(NOTO_SANS_REGULAR);
  const bold = await pdf.embedFont(NOTO_SANS_BOLD);

  // Falls back to A4 — `ProfileSchema`'s own default — rather than indexing to `undefined` and
  // failing on `.width`. A profile that predates the field, or one built by hand in a test, simply
  // does not carry it, and a missing paper size is not a reason to fail a render.
  const pageSize = PAGE_SIZES[profile.resumePageSize] ?? PAGE_SIZES.A4;
  const layout = new ResumeLayout(pdf, pageSize, density, regular, bold);

  layout.drawParagraph(profile.fullName, {
    font: bold,
    size: NAME_SIZE,
    letterSpacing: NAME_LETTER_SPACING,
    lineHeightMultiplier: NAME_LINE_HEIGHT,
  });
  layout.advance(3);
  layout.drawParagraph(contactLine(profile), {
    font: regular,
    size: CONTACT_SIZE,
    color: GREY_TEXT,
  });
  layout.advance(14);

  layout.drawSectionTitle('Skills', true);
  layout.drawParagraph(tailoredResume.skills.join(', '), layout.bodyStyle());

  layout.drawSectionTitle('Experience', false);
  tailoredResume.workExperience.forEach((job, index) => {
    // The gap between roles lives on the entry, not on its header row: putting it on the header
    // spaced the header from its *own* bullets' predecessor by the same amount, so a role read as
    // loosely attached to the one above it rather than as its own block.
    if (index > 0) layout.advance(density.entryGap);

    // Company and dates share a line; the role sits under them on its own. A recruiter scanning the
    // left edge reads the employers first, which is what the two-column "Title, Company" line this
    // replaced buried.
    layout.drawSplitRow(
      job.company,
      // Weight rather than size or italic: an oblique is too weak to read as emphasis.
      { font: bold, size: BODY_SIZE },
      `${job.startDate} – ${job.endDate ?? 'Present'}`,
      { font: regular, size: DATES_SIZE, color: GREY_TEXT },
    );
    layout.advance(1);
    layout.drawParagraph(
      profile.showRolePrefix ? `Role: ${job.title}` : job.title,
      layout.bodyStyle(),
    );

    for (const bullet of job.bullets) {
      layout.advance(density.bulletGap);
      layout.drawParagraph(`• ${bullet}`, layout.bodyStyle(), BULLET_INDENT);
    }
  });

  if (profile.education.length > 0) {
    layout.drawSectionTitle('Education', false);
    for (const entry of profile.education) {
      layout.advance(4);
      const field = entry.field ? `, ${entry.field}` : '';
      const year = entry.graduationYear ? ` (${entry.graduationYear})` : '';
      layout.drawParagraph(`${entry.degree}${field} — ${entry.school}${year}`, layout.bodyStyle());
    }
  }

  return layout.save();
}

/**
 * How many pages a rendered PDF has.
 *
 * Counted from the bytes rather than by re-parsing the document with a PDF library: the only
 * question here is "did this spill", the producer is this very module, and every `/Type /Page`
 * object it emits is one page. `Pages` is excluded by the trailing delimiter check — the page-tree
 * root is `/Type /Pages`, and matching it would inflate every count by one.
 */
export function pageCount(pdf: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(pdf);
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Renders a resume PDF and **fits it onto one page**.
 *
 * A tailored resume's length is not knowable in advance — the model rewrites the bullets per job,
 * and one wordier run is the difference between a full page and a page plus two orphan lines, which
 * reads worse than either. So this lays out at the researched density, and if the result spilled,
 * lays out again one step tighter, walking {@link DENSITY_STEPS} until it fits. The common case
 * costs exactly one pass: a resume that already fits never tries a tighter step.
 *
 * When even the tightest step spills, the tightest result is returned as-is — two pages, rather than
 * one page with the candidate's experience silently cut off. Losing content the candidate wrote is a
 * worse failure than a resume that runs long, and the caller can't tell the difference after the
 * fact. `docs/resume-design-conventions.md` §9 covers the real fix for that case: it is a content
 * problem (too many bullets), and it belongs upstream in `llm/tailorResume.ts`.
 *
 * @returns The rendered PDF bytes.
 */
export async function renderResumePdf(
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
  /**
   * The non-empty ladder to walk. Only a test passes this — narrowing it to a single step is how a
   * test shows that a given resume *needs* the compression, rather than merely fitting anyway.
   */
  densitySteps: readonly [Density, ...Density[]] = DENSITY_STEPS,
): Promise<Uint8Array> {
  let rendered: Uint8Array | null = null;

  for (const density of densitySteps) {
    const pass = await renderAtDensity(profile, tailoredResume, density);
    rendered = pass.bytes;
    if (pass.pages <= 1) {
      await preflightResumePdf(rendered, profile, tailoredResume);
      return rendered;
    }
  }

  // Non-null: the non-empty tuple guarantees the loop laid out at least once.
  await preflightResumePdf(rendered as Uint8Array, profile, tailoredResume);
  return rendered as Uint8Array;
}
