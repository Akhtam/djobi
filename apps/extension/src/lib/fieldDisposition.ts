/**
 * What the Application Pipeline does with each Detected Field category — its **disposition**.
 *
 * Every category has one: filled from the Profile, answered by the model, attached as a file, or
 * deliberately left alone. That decision existed before this module; it just wasn't written down
 * anywhere a compiler could read. It was inferable only by reading four call sites and noticing
 * which members they never mentioned — `background/applicationPipeline.ts`'s `switch` with a
 * `default`, its two `=== 'question'` / `=== 'resume_upload'` tests, and the upload pick in
 * `content/fillForm.ts`.
 *
 * The cost of that was not hypothetical. Cover-letter fields are detected and deliberately not
 * filled — `PROGRESS.md` says so under "Constraints that look like mistakes", because
 * `answerQuestions` is wired only to `question` fields — but the code implementing that decision was
 * a `default` branch, which looks exactly like having forgotten. A deliberate omission and an
 * oversight were the same line.
 *
 * This lives in the **extension**, not in `@djobi/shared`. Only the category *vocabulary* is shared,
 * because both halves of the wire have to agree on it. What to *do* with a category is this app's
 * policy: it is the Application Pipeline that fills, and the rules here are extension-specific down
 * to splitting a `fullName` into a first and last name. How the DOM earns a category stays in
 * `content/detectFields.ts`, and how a field is interacted with stays in `content/fillForm.ts` —
 * different policies, different modules, changing for different reasons.
 */
import type { FieldCategory, Profile } from '@djobi/shared';

/**
 * Where a Detected Field's value comes from.
 *
 * `'unsupported'` is a decision on the record, not a gap: the field is detected, it crosses every
 * boundary, and nothing fills it — on purpose. Saying so here is what separates it from a category
 * somebody forgot.
 */
export type AutofillSource = 'profile' | 'question' | 'resume' | 'unsupported';

/**
 * Every category's disposition, exhaustively.
 *
 * `satisfies Record<FieldCategory, AutofillSource>` is the whole mechanism. A 15th category cannot
 * be added to `FieldCategorySchema` without this object failing to compile, which is the pressure
 * the `default` branch used to absorb silently. `satisfies` rather than an annotation so the literal
 * keeps its narrow value types, which is what {@link ProfileBackedCategory} derives the profile
 * subset from below.
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
 * The categories {@link AUTOFILL_SOURCE} marks as coming from the Profile, derived from the table
 * rather than restated beside it.
 *
 * Restating the list is what let the two drift in the first place. Marking a new category
 * `'profile'` above now forces an entry in {@link PROFILE_VALUE} below, and demoting one to
 * `'unsupported'` forces its removal — neither is something to remember.
 */
type ProfileBackedCategory = {
  [K in FieldCategory]: (typeof AUTOFILL_SOURCE)[K] extends 'profile' ? K : never;
}[FieldCategory];

/**
 * How each profile-backed category is projected out of a Profile.
 *
 * `undefined` means "nothing to fill", and it is deliberately not `''`: the Profile stores a cleared
 * optional as `null` (see `orNull` in `options/App.tsx`), and writing an empty string would overwrite
 * whatever the ATS had already put in the box.
 */
/**
 * A stored value as something worth writing, or `undefined` when there is nothing there.
 *
 * Every projection below goes through this, because the rule above — blank means "leave the box
 * alone", never "write an empty string over it" — was implemented on `last_name` alone. `fullName`
 * and `email` are plain `z.string()` with no minimum (`EMPTY_PROFILE` starts both at `''`, and the
 * profile form marks neither required), so a profile saved without a name filled `first_name` and
 * `full_name` with `''` and wiped whatever the ATS had already prefilled into them.
 */
function filled(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The name's parts, split on any run of whitespace so a double space doesn't yield a blank part. */
function nameParts(profile: Profile): string[] {
  const name = profile.fullName.trim();
  return name ? name.split(/\s+/) : [];
}

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
 * The Profile value that fills `category`, or `undefined` for a category the Profile doesn't back —
 * a question, the resume upload, or one this app deliberately leaves alone.
 */
export function valueForCategory(category: FieldCategory, profile: Profile): string | undefined {
  const source = AUTOFILL_SOURCE[category];
  if (source !== 'profile') return undefined;
  return PROFILE_VALUE[category as ProfileBackedCategory](profile);
}
