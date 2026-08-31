/** Turns an unknown rejection value into a stable diagnostic string. */
export function failureMessage(value: unknown): string {
  if (value instanceof Error) return value.message || 'Unknown error';
  if (typeof value === 'string') return value || 'Unknown error';
  if (value == null) return 'Unknown error';
  try {
    return String(value);
  } catch {
    return 'Unknown error';
  }
}
