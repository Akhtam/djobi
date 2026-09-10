/**
 * The Importance Gate: the deterministic check that stops an extraction model's market-knowledge
 * guess from reaching the two bands that create obligations.
 *
 * `extractJob` asks the model for a {@link RequirementImportance} band per requirement, plus an
 * {@link ImportanceTier} saying where the band came from and, for a `stated` tier, the posting's own
 * wording it rests on. A band is only worth as much as its tier, and a tier is only worth as much as
 * whether anyone checks it. This module is that check.
 *
 * **Why a gate rather than a better prompt.** The bands that matter are `critical` and `high`: those
 * are the ones a reader acts on, the ones the requirement views refuse to trim, and the ones the
 * eval script flags when unsupported. Everything else is ordering. So the only judgement the model
 * has to get right is one it can be held to — *does the posting say this*. Under this gate a
 * consequential band is a found quotation, not reasoning and not a claim about layout, which is why the cheap model
 * `routing.ts` sends `extractJob` to is the right one and not a compromise.
 *
 * **The asymmetry is deliberate and runs one way.** An inflated band on a requirement the candidate
 * lacks reads as "don't bother applying", and that error costs an application the candidate should
 * have made and didn't. An under-weighted real requirement costs a worse-prepared interview, which
 * is recoverable. The cap sits on the side where being wrong isn't.
 *
 * **What this never does.** It never raises a band, never invents one for a requirement the model
 * left unassessed, and never edits `text`, `kind` or `yearsOfExperience`. Same discipline as
 * `keywordCoverage.ts` and `requirementEvidence.ts`: deterministic, no model call, and it can only
 * take away what the posting does not support.
 */
import type { JobRequirement, RequirementImportance } from './schemas.js';

/**
 * The bands that decide an application, and therefore the only ones that create obligations.
 *
 * One exported set because four places need the same answer and must not be able to disagree: the
 * cap below refuses to let a guess reach these; the dashboard's row budget refuses to trim them;
 * the extraction eval flags them when unsupported. Spelling `'critical' || 'high'` out inline at
 * each site is how a later sixth band gets added to three of the four.
 */
export const DECISIVE_BANDS: ReadonlySet<RequirementImportance> = new Set(['critical', 'high']);

/** What a capped band is lowered to: the highest band that creates no obligation. */
const CAP = 'meaningful' as const;

/**
 * A posting and a model's quote of it agree on words, not on layout.
 *
 * `normalizeLabel` in `labelMatching.ts` only trims and lowercases, which is right for the problem
 * it serves — two spellings of one form label, both already single-line. A job posting is not:
 * the line the model quotes was wrapped, bulleted and indented in the source, so a literal
 * comparison fails on whitespace the quote is not lying about. Collapsing runs of whitespace is
 * therefore scoped here rather than pushed into the shared helper, the same way
 * `requirementEvidence.ts` keeps its own stopword list instead of borrowing that module's.
 *
 * Nothing else is normalized. Stripping punctuation or stemming would start forgiving the very
 * paraphrase this function exists to catch.
 *
 * Exported for the extraction eval, which re-runs this same check against live model output to
 * report how often the gate had to fire. A second copy there would be a check of a different rule
 * that merely looked like this one.
 */
export function normalizeQuote(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whether `signal` is a span the normalized `posting` actually contains.
 *
 * Exported for the extraction eval, which re-runs the gate's own predicate rather than re-spelling
 * it: a second copy there would drift into checking a different rule that merely looked like this
 * one, and would then be unable to report the cases the gate itself misses.
 *
 * The emptiness check is the point: `String.includes('')` is true of every string, so a `stated`
 * row whose signal is `''` or pure whitespace would otherwise pass a check it supplies nothing to.
 * A quote naming no words is the same claim as a quote naming none — an omission — and is treated
 * the same way.
 */
export function quoteHolds(signal: string | null, posting: string): boolean {
  if (signal === null) return false;
  const quote = normalizeQuote(signal);
  return quote.length > 0 && posting.includes(quote);
}

/**
 * `requirements` with every band the posting cannot back lowered to one it can.
 *
 * Applied per requirement, in this order:
 *
 * 1. **The quote check.** A `stated` tier claims the posting says so in as many words, so its
 *    `postingSignal` must occur in `rawDescription` as a literal span (whitespace and case aside). A
 *    quote that does not — a paraphrase, a stitched-together sentence, an invention — demotes the
 *    tier to `inferred` and drops the `postingSignal`, because a quote that cannot be found is not
 *    evidence of anything and keeping it would let a reader audit it as though it were.
 *    A `stated` row that supplies *no* quote fails this check too. The tier's whole claim is that
 *    the posting says so in as many words; a row making that claim while naming no words has
 *    nothing to audit, and treating the omission as a pass would make the quote optional exactly
 *    where it is the only thing being checked.
 * 2. **A missing tier is `inferred`.** A band with no tier is a band with no stated basis, and the
 *    conservative reading is the one that assumes the least.
 * 3. **The cap.** A `critical` or `high` band is lowered to `meaningful` unless it ends up `stated`
 *    with a quote that was found. `structural` is capped alongside `inferred`, and for the same
 *    reason: nothing checks a section reference, so leaving it uncapped would make it the cheapest
 *    route to a decisive band — strictly easier to produce than a verbatim quote, and therefore the
 *    one a model under pressure would take. A `structural` row keeps its `postingSignal`, which is
 *    a real reference to the posting's layout even though it is not a quote. Any row that ends up
 *    `inferred` loses its `postingSignal`, including one the model sent that way with a signal
 *    attached: an `inferred` band rests on market knowledge by definition, so a posting reference
 *    beside it is either mislabelled or made up, and neither is worth keeping.
 *
 * Step 1 before step 3 is the whole mechanism. Were the cap applied first, a model could launder a
 * guess into `critical` merely by attaching a plausible-looking quote; running the check first means
 * a bad quote lands the row in exactly the tier the cap then catches.
 *
 * A requirement with no band is returned untouched — `null` is "not assessed", never a low band, so
 * there is nothing here to cap.
 *
 * @param requirements - The requirements as extracted, before anything downstream has read them.
 * @param rawDescription - The posting text the extraction was run against, unmodified.
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
