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
