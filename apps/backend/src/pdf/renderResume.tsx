import type { Profile, TailoredResume } from '@djobi/shared';
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import React from 'react';

/**
 * The layout, per `docs/resume-design-conventions.md` — every value there is inside a range some
 * primary source states, and the doc names which one. The short version of why these numbers and
 * not others:
 *
 * - **Hierarchy comes from weight, case, spacing and a hairline rule — never from size alone.**
 *   Section headings are only 1.05× body (Butterick's "smallest increment that works"); caps, bold
 *   and the rule carry the distinction. This is what keeps a minimal resume from looking like a
 *   ransom note of competing sizes.
 * - **Two floors this file used to sit under.** `padding: 32` is 0.44", below MIT's 0.5" minimum;
 *   and no `lineHeight` at all left react-pdf's ~1.15 default under Butterick's 120% floor. Both
 *   are readability floors, so both are raised here.
 * - **Nothing here fights the ATS.** Single column, no images, no `fixed` page header, `•` bullets
 *   that were verified to extract cleanly from this renderer. `letterSpacing` stays ≤1pt: it moves
 *   glyph advance rather than inserting space characters, so `RESUME` extracts as `RESUME`, but
 *   large tracking can make an extractor synthesise word breaks.
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
interface Density {
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
export const DENSITY_STEPS: Density[] = [
  { lineHeight: 1.45, pagePaddingVertical: 40, sectionGap: 18, entryGap: 11, bulletGap: 2.5 },
  { lineHeight: 1.35, pagePaddingVertical: 40, sectionGap: 14, entryGap: 9, bulletGap: 2 },
  { lineHeight: 1.3, pagePaddingVertical: 38, sectionGap: 12, entryGap: 8, bulletGap: 1.5 },
  { lineHeight: 1.25, pagePaddingVertical: 36, sectionGap: 10, entryGap: 7, bulletGap: 1 },
];

const createStyles = (density: Density) =>
  StyleSheet.create({
    page: {
      paddingTop: density.pagePaddingVertical,
      paddingBottom: density.pagePaddingVertical,
      // Wider than the vertical padding: it shortens the measure toward the readable line length
      // without spending the vertical space the content needs.
      paddingHorizontal: 60,
      fontSize: 10,
      lineHeight: density.lineHeight,
      fontFamily: 'Helvetica',
      color: '#000000',
    },

    name: {
      fontSize: 17,
      fontFamily: 'Helvetica-Bold',
      // Tighter than the body: a single line has no return sweep to leave room for.
      lineHeight: 1.2,
      letterSpacing: 0.3,
      marginBottom: 3,
    },

    // Below body size, and grey — this is the one block a reader should skip until they need it.
    contactLine: { fontSize: 9, color: '#333333', marginBottom: 14 },

    sectionTitle: {
      fontSize: 10.5,
      fontFamily: 'Helvetica-Bold',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      borderBottomWidth: 0.75,
      borderBottomColor: '#999999',
      paddingBottom: 2,
      // Deliberately asymmetric: a heading belongs to what follows it, so it sits nearer its own
      // content than the section above.
      marginTop: density.sectionGap,
      marginBottom: 6,
    },
    /** First heading only — `contactLine`'s bottom margin already separates it. */
    sectionTitleFirst: { marginTop: 0 },

    skillsLine: {},

    // The gap between roles lives on the entry, not on its header row: putting it on the header
    // spaced the header from its *own* bullets' predecessor by the same amount, so a role read as
    // loosely attached to the one above it rather than as its own block.
    jobEntry: { marginTop: density.entryGap },
    /** First role only — the section heading's bottom margin already separates it. */
    jobEntryFirst: { marginTop: 0 },

    jobHeader: { flexDirection: 'row', justifyContent: 'space-between' },
    // Weight rather than size or italic: Helvetica's oblique is too weak to read as emphasis.
    jobCompany: { fontFamily: 'Helvetica-Bold' },
    jobDates: { fontSize: 9.5, color: '#333333' },
    jobRole: { marginTop: 1 },

    bullet: { marginLeft: 11, marginTop: density.bulletGap },
    educationEntry: { marginTop: 4 },
  });

/** Contact-info line: email, phone, location, and any non-null links, joined with ` · `. */
function contactLine(profile: Profile): string {
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
 * The resume PDF layout: contact info + education from {@link Profile} (these don't vary per
 * job), skills/work-experience from {@link TailoredResume} (these do).
 */
function ResumeDocument({
  profile,
  tailoredResume,
  density,
}: {
  profile: Profile;
  tailoredResume: TailoredResume;
  density: Density;
}) {
  const styles = createStyles(density);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.name}>{profile.fullName}</Text>
        <Text style={styles.contactLine}>{contactLine(profile)}</Text>

        <Text style={[styles.sectionTitle, styles.sectionTitleFirst]}>Skills</Text>
        <Text style={styles.skillsLine}>{tailoredResume.skills.join(', ')}</Text>

        <Text style={styles.sectionTitle}>Experience</Text>
        {tailoredResume.workExperience.map((job, i) => (
          <View key={i} style={i === 0 ? [styles.jobEntry, styles.jobEntryFirst] : styles.jobEntry}>
            {/* Company and dates share a line; the role sits under them on its own. A recruiter
                scanning the left edge reads the employers first, which is what the two-column
                "Title, Company" line this replaced buried. */}
            <View style={styles.jobHeader}>
              <Text style={styles.jobCompany}>{job.company}</Text>
              <Text style={styles.jobDates}>
                {job.startDate} – {job.endDate ?? 'Present'}
              </Text>
            </View>
            <Text style={styles.jobRole}>Role: {job.title}</Text>
            {job.bullets.map((bullet, j) => (
              <Text key={j} style={styles.bullet}>
                • {bullet}
              </Text>
            ))}
          </View>
        ))}

        {profile.education.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Education</Text>
            {profile.education.map((edu, i) => (
              <Text key={i} style={styles.educationEntry}>
                {edu.degree}
                {edu.field ? `, ${edu.field}` : ''} — {edu.school}
                {edu.graduationYear ? ` (${edu.graduationYear})` : ''}
              </Text>
            ))}
          </>
        )}
      </Page>
    </Document>
  );
}

/**
 * How many pages a rendered PDF has, read from its page tree.
 *
 * Counted from the bytes rather than by re-parsing the document with a PDF library: the only
 * question here is "did this spill", the producer is this very module, and every `/Type /Page`
 * object it emits is one page. `Pages` is excluded by the trailing delimiter check — the page-tree
 * root is `/Type /Pages`, and matching it would inflate every count by one.
 */
export function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/**
 * Renders a resume PDF: contact info and education come from the base `profile` (they don't need
 * per-job tailoring), skills/work-experience come from `tailoredResume`.
 *
 * **Fits it onto one page.** A tailored resume's length is not knowable in advance — the model
 * rewrites the bullets per job, and one wordier run is the difference between a full page and a
 * page plus two orphan lines, which reads worse than either. So this renders at the researched
 * density, and if the result spilled, renders again one step tighter, walking {@link DENSITY_STEPS}
 * until it fits. The common case costs exactly one render: a resume that already fits never tries
 * a tighter step.
 *
 * When even the tightest step spills, the tightest render is returned as-is — two pages, rather
 * than one page with the candidate's experience silently cut off. Losing content the candidate
 * wrote is a worse failure than a resume that runs long, and the caller can't tell the difference
 * after the fact. `docs/resume-design-conventions.md` §9 covers the real fix for that case: it is a
 * content problem (too many bullets), and it belongs upstream in `llm/tailorResume.ts`.
 *
 * @returns The rendered PDF as a `Buffer`.
 */
export async function renderResumePdf(
  profile: Profile,
  tailoredResume: TailoredResume,
  /**
   * The ladder to walk. Only a test passes this — narrowing it to a single step is how a test
   * shows that a given resume *needs* the compression, rather than merely fitting anyway.
   */
  densitySteps: Density[] = DENSITY_STEPS,
): Promise<Buffer> {
  let rendered: Buffer | null = null;

  for (const density of densitySteps) {
    rendered = await renderToBuffer(
      <ResumeDocument profile={profile} tailoredResume={tailoredResume} density={density} />,
    );
    if (pageCount(rendered) <= 1) return rendered;
  }

  // Non-null: the ladder is never empty, so the loop above always rendered at least once.
  return rendered as Buffer;
}
