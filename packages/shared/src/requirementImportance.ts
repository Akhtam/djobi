/**
 * The Importance Gate: stops a model's market-knowledge guess from reaching `critical` or `high`.
 *
 * `extractJob` returns a {@link RequirementImportance} band per requirement plus an
 * {@link ImportanceTier} (where the band came from) and, for `stated`, the posting's own words.
 * Rather than trust the prompt, only a verified verbatim quote can carry a decisive band — which is
 * why the cheap extraction model is sufficient.
 *
 * The cap errs one way: an inflated band can talk a candidate out of applying; an under-weighted
 * one only costs interview prep. It never raises a band, invents one, or edits other fields.
 */
import type { JobRequirement, RequirementImportance } from './schemas.js';

/**
 * The bands a reader acts on. Shared by the cap below, the dashboard's row budget (never trims
 * these) and the extraction eval (flags them when unsupported).
 */
export const DECISIVE_BANDS: ReadonlySet<RequirementImportance> = new Set(['critical', 'high']);

/** What a capped band is lowered to: the highest band that creates no obligation. */
const CAP = 'meaningful' as const;

/**
 * Normalizes for quote comparison: lowercases and collapses whitespace (the posting was wrapped
 * and bulleted; the quote wasn't). Nothing else — stripping punctuation or stemming would forgive
 * paraphrase. Exported for the extraction eval.
 */
export function normalizeQuote(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whether `signal` is a non-empty span of the normalized `posting`. Empty counts as missing
 * (`''.includes` is always true). Exported for the extraction eval.
 */
export function quoteHolds(signal: string | null, posting: string): boolean {
  if (signal === null) return false;
  const quote = normalizeQuote(signal);
  return quote.length > 0 && posting.includes(quote);
}

/**
 * `requirements` with every band the posting cannot back lowered, per requirement, in order:
 *
 * 1. **Quote check.** A `stated` tier whose `postingSignal` is missing or not a literal span of
 *    `rawDescription` is demoted to `inferred`.
 * 2. **Missing tier** is treated as `inferred`.
 * 3. **Cap.** `critical`/`high` drop to `meaningful` unless `stated` with a found quote.
 *    `structural` is capped too (nothing verifies it, so it would be the cheapest route to a
 *    decisive band) but keeps its `postingSignal`. `inferred` rows always lose `postingSignal`.
 *
 * Checking before capping stops a model laundering a guess with a plausible-looking quote. A `null`
 * band means "not assessed" and is returned untouched.
 *
 * @param rawDescription - The unmodified posting text the extraction ran against.
 */
export function normalizeRequirementImportance(
  requirements: readonly JobRequirement[],
  rawDescription: string,
): JobRequirement[] {
  const posting = normalizeQuote(rawDescription);

  return requirements.map((requirement): JobRequirement => {
    if (requirement.importance === null) return requirement;

    const tier =
      requirement.importanceTier === 'stated' && !quoteHolds(requirement.postingSignal, posting)
        ? 'inferred'
        : (requirement.importanceTier ?? 'inferred');

    return {
      ...requirement,
      importance:
        tier !== 'stated' && DECISIVE_BANDS.has(requirement.importance)
          ? CAP
          : requirement.importance,
      importanceTier: tier,
      postingSignal: tier === 'inferred' ? null : requirement.postingSignal,
    };
  });
}
