import type { Profile } from '@djobi/shared';

/** The Profile keys holding an editable list of entries. */
export type ProfileListKey =
  | 'workExperience'
  | 'education'
  | 'projects'
  | 'certifications'
  | 'awards'
  | 'stories'
  | 'customAnswers';

/** The three things every list section does to its list. Bound to one key by {@link listEditor}. */
export interface ListEditor<T> {
  update: (index: number, patch: Partial<T>) => void;
  remove: (index: number) => void;
  add: () => void;
}

/**
 * Add/update/remove for one Profile list key. `blank` is a thunk so a new entry can carry a
 * generated value (a story id).
 */
export function listEditor<K extends ProfileListKey>(
  profile: Profile,
  setProfile: (profile: Profile) => void,
  key: K,
  blank: () => Profile[K][number],
): ListEditor<Profile[K][number]> {
  const list = profile[key] as Profile[K][number][];

  const write = (next: Profile[K][number][]) => setProfile({ ...profile, [key]: next });

  return {
    update: (index, patch) =>
      write(list.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))),
    remove: (index) => write(list.filter((_, i) => i !== index)),
    add: () => write([...list, blank()]),
  };
}

/**
 * One row of the combined Certifications & Awards section. Flat, not a union, because `Partial` of
 * a union drops award-only `description`; on a certification it's simply unused.
 */
export interface CredentialItem {
  kind: 'certification' | 'award';
  index: number;
  name: string;
  issuer: string;
  date: string;
  description?: string | undefined;
}

/** Certifications, then awards, each tagged with where it lives — see {@link CredentialItem}. */
export function credentialItems(profile: Profile): CredentialItem[] {
  return [
    ...profile.certifications.map((entry, index) => ({
      kind: 'certification' as const,
      index,
      ...entry,
    })),
    ...profile.awards.map((entry, index) => ({ kind: 'award' as const, index, ...entry })),
  ];
}
