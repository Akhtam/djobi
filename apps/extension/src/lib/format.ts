import type { ApplicationStage } from '@djobi/shared';

/** Display formatting for the panel; mirrors `apps/dashboard/src/lib/format.ts`. */

/**
 * A saved Application's date in the reader's locale (Duplicate Guard notice, Log tab warning).
 */
export function formatAppliedDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(undefined, { dateStyle: 'long' });
}

/**
 * Human-readable stage names (the snake_case enum must not reach the screen). Mirrors the
 * dashboard's `STAGE_LABELS`; a test asserts every stage is covered.
 */
const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: 'Applied',
  rejected_ats: 'Rejected (ATS)',
  phone_screen: 'Phone screen',
  onsite: 'Onsite',
  offer: 'Offer',
  rejected: 'Rejected',
};

/** The stage of a past application, for the Duplicate Guard notice. */
export function formatStage(stage: ApplicationStage): string {
  return STAGE_LABELS[stage];
}
