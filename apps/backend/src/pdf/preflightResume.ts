import type { RenderResumePdfProfile, TailoredResume } from '@djobi/shared';
import { extractPdfText } from './extractPdfText.js';

const MIN_PDF_BYTES = 1_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function expectedReadingOrder(
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
): string[] {
  const contact = [
    profile.fullName,
    profile.email,
    profile.phone,
    profile.location,
    profile.links.linkedin,
    profile.links.portfolio,
    profile.links.github,
  ];
  const experience = tailoredResume.workExperience.flatMap((job) => [
    job.company,
    job.startDate,
    job.endDate ?? 'Present',
    profile.showRolePrefix ? `Role: ${job.title}` : job.title,
    ...job.bullets,
  ]);
  const education = profile.education.flatMap((entry) => [
    entry.degree,
    entry.field,
    entry.school,
    entry.graduationYear,
  ]);

  return [
    ...contact,
    'Skills',
    ...tailoredResume.skills,
    'Experience',
    ...experience,
    ...(profile.education.length > 0 ? ['Education', ...education] : []),
  ].filter((value): value is string => Boolean(value));
}

/**
 * Parses a completed PDF and rejects it if expected resume content was lost or reordered.
 * This is deliberately a report/check seam: it never mutates candidate content to make a render pass.
 */
export async function preflightResumePdf(
  pdfBytes: Uint8Array,
  profile: RenderResumePdfProfile,
  tailoredResume: TailoredResume,
): Promise<void> {
  if (pdfBytes.length < MIN_PDF_BYTES || pdfBytes.length > MAX_PDF_BYTES) {
    throw new Error(
      `Resume PDF preflight failed: file size ${pdfBytes.length} is outside ${MIN_PDF_BYTES}-${MAX_PDF_BYTES} bytes`,
    );
  }

  try {
    const text = await extractPdfText(pdfBytes);
    const renderedText = normalized(text);
    let cursor = 0;

    for (const expected of expectedReadingOrder(profile, tailoredResume)) {
      const fragment = normalized(expected);
      const foundAt = renderedText.indexOf(fragment, cursor);
      if (foundAt < 0) {
        throw new Error(`missing or out-of-order text: ${JSON.stringify(expected)}`);
      }
      cursor = foundAt + fragment.length;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Resume PDF preflight failed: ${detail}`, { cause: error });
  }
}
