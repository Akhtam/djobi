/**
 * Each Detected Field category's **disposition**: filled from the Profile, answered by the model,
 * attached as a file, or deliberately left alone (`'unsupported'`, e.g. cover letters).
 *
 * Extension policy, not shared: only the category vocabulary is in `@djobi/shared`. Detection
 * lives in `content/detectFields.ts` and interaction in `content/fillForm.ts`.
 */
import type { FieldCategory, Profile } from '@djobi/shared';

/**
 * Where a Detected Field's value comes from. `'unsupported'` is a recorded decision, not a gap.
 */
export type AutofillSource = 'profile' | 'question' | 'resume' | 'unsupported';

/**
 * Every category's disposition. `satisfies Record<FieldCategory, AutofillSource>` makes a new
 * category a compile error until it's given one, and keeps literal types for
 * {@link ProfileBackedCategory}.
 */
export const AUTOFILL_SOURCE = {
  first_name: 'profile',
  last_name: 'profile',
  full_name: 'profile',
  email: 'profile',
  phone: 'profile',
  location: 'profile',
  linkedin_url: 'profile',
  portfolio_url: 'profile',
  github_url: 'profile',
  resume_upload: 'resume',
  // Detected, and deliberately not filled. See this module's header and `PROGRESS.md`.
  cover_letter_upload: 'unsupported',
  cover_letter_text: 'unsupported',
  question: 'question',
  unknown: 'unsupported',
} satisfies Record<FieldCategory, AutofillSource>;

/** What the Application Pipeline does with `category`. */
export function autofillSource(category: FieldCategory): AutofillSource {
  return AUTOFILL_SOURCE[category];
}

/**
 * The `'profile'` categories, derived from {@link AUTOFILL_SOURCE} — so {@link PROFILE_VALUE} must
 * cover exactly them.
 */
type ProfileBackedCategory = {
  [K in FieldCategory]: (typeof AUTOFILL_SOURCE)[K] extends 'profile' ? K : never;
}[FieldCategory];

/**
 * A stored value worth writing, or `undefined` for blank. Blank means "leave the box alone", never
 * "write `''` over what the ATS prefilled".
 */
function filled(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * The name's parts, split on any run of whitespace so a double space doesn't yield a blank part.
 */
function nameParts(profile: Profile): string[] {
  const name = profile.fullName.trim();
  return name ? name.split(/\s+/) : [];
}

/**
 * How each Profile-backed category is read from a Profile. `undefined` means "nothing to fill" —
 * never `''`, which would overwrite what the ATS prefilled.
 */
const PROFILE_VALUE: Record<ProfileBackedCategory, (profile: Profile) => string | undefined> = {
  // A mononym has no surname to give, so `last_name` is empty rather than a repeat of the first.
  first_name: (profile) => filled(nameParts(profile)[0]),
  last_name: (profile) => filled(nameParts(profile).slice(1).join(' ')),
  full_name: (profile) => filled(profile.fullName),
  email: (profile) => filled(profile.email),
  phone: (profile) => filled(profile.phone),
  location: (profile) => filled(profile.location),
  linkedin_url: (profile) => filled(profile.links.linkedin),
  portfolio_url: (profile) => filled(profile.links.portfolio),
  github_url: (profile) => filled(profile.links.github),
};

/**
 * The Profile value for `category`, or `undefined` for a category the Profile doesn't back.
 */
export function valueForCategory(category: FieldCategory, profile: Profile): string | undefined {
  const source = AUTOFILL_SOURCE[category];
  if (source !== 'profile') return undefined;
  return PROFILE_VALUE[category as ProfileBackedCategory](profile);
}
