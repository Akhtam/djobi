import type { RenderResumePdfProfile, TailoredResume } from '@djobi/shared';
import { layoutText, ops, PDF, rgb, type EmbeddedFont } from '@libpdf/core';
import { notoSansBoldBase64, notoSansRegularBase64 } from './notoSansFonts.js';
import { preflightResumePdf } from './preflightResume.js';

/**
 * Decodes a base64 font blob. `atob`, not `Buffer`, so it runs in a Worker without `nodejs_compat`.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Decoded once: the bytes are constant and involve no env or I/O, so eager work is Worker-safe.
const NOTO_SANS_REGULAR = decodeBase64(notoSansRegularBase64);
const NOTO_SANS_BOLD = decodeBase64(notoSansBoldBase64);

/**
 * The knobs the one-page fit may turn — leading and whitespace, never type size (body text never
 * drops below 10pt). Every value is within a range `docs/resume-design-conventions.md` sources.
 *
 * Hierarchy comes from weight, caps, spacing and a hairline rule rather than size. The layout stays
 * ATS-safe: single column, no images, no repeated header, `•` bullets, and `letterSpacing` ≤1pt via
 * the `Tc` operator so text still extracts intact.
 */
export interface Density {
  lineHeight: number;
  pagePaddingVertical: number;
  sectionGap: number;
  entryGap: number;
  bulletGap: number;
}

/**
 * Density steps, loosest first, walked by {@link renderResumePdf} until the resume fits one page.
 * The tightest sits on the sourced floors (leading 1.25, 36pt padding); there is no step below it.
 */
export const DENSITY_STEPS: readonly [Density, ...Density[]] = [
  { lineHeight: 1.45, pagePaddingVertical: 40, sectionGap: 18, entryGap: 11, bulletGap: 2.5 },
  { lineHeight: 1.35, pagePaddingVertical: 40, sectionGap: 14, entryGap: 9, bulletGap: 2 },
  { lineHeight: 1.3, pagePaddingVertical: 38, sectionGap: 12, entryGap: 8, bulletGap: 1.5 },
  { lineHeight: 1.25, pagePaddingVertical: 36, sectionGap: 10, entryGap: 7, bulletGap: 1 },
];

/** Page dimensions in points, kept next to the layout measured against them. */
const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
} as const;

/**
 * Wider than the vertical padding to shorten the line measure (Noto Sans runs wide) without
 * spending vertical space; still above the 36pt floor.
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
 * Lays a resume out top-down across as many pages as needed. The cursor is measured from the page
 * top and converted to PDF's bottom-left origin only when drawing. Overflow starts a new page —
 * never drops content — so {@link renderResumePdf} can measure a spill and retry tighter.
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
   * Baseline offset from the font's own ascent, so both weights share a baseline on one line.
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
   * Draws one line at `x`, starting a new page first if needed. Tracking uses the `Tc` operator,
   * which changes glyph advance but keeps the string intact for extractors and
   * `preflightResumePdf`.
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
   * The wrap width for `layoutText`, reduced by the tracking `Tc` adds (which `layoutText` doesn't
   * account for), so tracked runs like the name can't overflow the margin.
   */
  private wrapWidth(width: number, text: string, style: TextStyle): number {
    return width - (style.letterSpacing ?? 0) * text.length;
  }

  /**
   * Draws a wrapped paragraph. `layoutText` never splits a word, so no hyphen enters the content
   * stream to fail `preflightResumePdf`'s text comparison.
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
   * A row with one run left and one right (company/dates). The left run wraps to the space the
   * right leaves.
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

    // Left run drawn first on a shared baseline, so extraction reads "Acme 2020-01 – Present" as
    // one line in the order `preflightResumePdf` requires.
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
   * A section heading: tracked caps over a hairline rule, sitting closer to its own content than to
   * the section above.
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
    // Subset to used glyphs: ~15 KB instead of ~400 KB per resume.
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
 * Lays the resume out at one density; returns the bytes and page count. Contact info and education
 * come from `profile`; skills and experience from `tailoredResume`.
 */
async function renderAtDensity(
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
  density: Density,
): Promise<{ bytes: Uint8Array; pages: number }> {
  // A fresh document (and fonts) per pass: `EmbeddedFont` accumulates used glyphs, so sharing it
  // would leak one candidate's glyphs into another's subset.
  const pdf = PDF.create();
  const regular = await pdf.embedFont(NOTO_SANS_REGULAR);
  const bold = await pdf.embedFont(NOTO_SANS_BOLD);

  // Defaults to A4 (`ProfileSchema`'s default) when the field is missing.
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
    // The gap belongs to the entry, so each role reads as its own block.
    if (index > 0) layout.advance(density.entryGap);

    // Company and dates on one line, role beneath, so employers line the left edge.
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
 * Page count from the bytes (`/Type /Page` objects, excluding `/Pages`) — enough since this module
 * produced the PDF.
 */
export function pageCount(pdf: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(pdf);
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Renders a resume PDF and fits it onto one page: lays out at the loosest density, then walks
 * {@link DENSITY_STEPS} tighter until it fits (one pass in the common case).
 *
 * If even the tightest step spills, the two-page result is returned — never silently truncated
 * content. Too many bullets is a content problem for `llm/tailorResume.ts`.
 *
 * @returns The rendered PDF bytes.
 */
export async function renderResumePdf(
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
  /** The ladder to walk; tests narrow it to show a resume needs compression. */
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
