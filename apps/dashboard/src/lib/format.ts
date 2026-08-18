/**
 * Turning stored values into display strings. Split out of `stages.ts`, which had grown a second
 * unrelated job: a module named for stages should not be where `NotesLog` reaches for a date
 * formatter.
 */
/** `2026-03-14T09:12:00Z` -> `Mar 14, 2026`. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** `2026-03-14T09:12:00Z` -> `Mar 14, 2026, 9:12 AM`. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
