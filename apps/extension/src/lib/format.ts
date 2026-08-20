import type { ApplicationStage } from '@djobi/shared';

/**
 * Turning stored values into display strings for the panel.
 *
 * Mirrors `apps/dashboard/src/lib/format.ts`, which exists for the same reason: a formatter reached
 * for by more than one component belongs beside them, not copied into each.
 */

/**
 * When a past application was saved, in the reader's own locale — stored as an ISO string.
 *
 * Both places that report a past application read this: the Autofill tab's Duplicate Guard notice
 * and the Log tab's already-logged warning.
 */
export function formatAppliedDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(undefined, { dateStyle: 'long' });
}

/**
 * A stage's human-readable name. The enum values are snake_case and must not reach the screen.
 *
 * Mirrors `STAGE_LABELS` in `apps/dashboard/src/lib/stages.ts`, for the same reason this whole file
 * mirrors the dashboard's `format.ts`. The dashboard's copy sits beside filter groupings and CSS
 * modifiers that are meaningless here, so only the labels are duplicated. A test asserts this map
 * covers every stage, so adding one fails here rather than rendering `phone_screen` to a candidate.
 */
const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: 'Applied',
  rejected_ats: 'Rejected (ATS)',
  phone_screen: 'Phone screen',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
};

/** The stage of a past application, for the Duplicate Guard notice. */
export function formatStage(stage: ApplicationStage): string {
  return STAGE_LABELS[stage];
}
