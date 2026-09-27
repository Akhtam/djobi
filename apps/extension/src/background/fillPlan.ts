import type { DetectedField, Profile } from '@djobi/shared';
import { autofillSource, valueForCategory } from '../lib/fieldDisposition';
import type { FillFormResult } from '../lib/messages';
import { answersFor, type AnalyzedRun, type FillOutcome, type PipelineRunState } from '../lib/run';
import { mergeRescan } from './detectedFields';

/**
 * The Fill Step's decisions without its I/O: what to write before the page command, and what the
 * page's answer means after it. `applicationPipeline.ts`'s `fillStep` does the claiming, scanning,
 * rendering and filling around these pure functions.
 */
export interface FillPlan {
  /**
   * The fields to fill: the fresh scan when there is one, the analyzed run's detection otherwise.
   */
  fields: DetectedField[];
  /** Each field's value by id. Only fields something has a value for — see {@link planFill}. */
  values: Record<string, string>;
  /** Whether to render and attach a resume at all — not which input it lands on. */
  needsResume: boolean;
}

/** Whether any of `fields` is a resume upload. */
export function asksForResume(fields: DetectedField[]): boolean {
  return fields.some((field) => autofillSource(field.category) === 'resume');
}

/**
 * What to fill, from the analyzed run and the page now. `scanned` is `null`/empty when the page
 * couldn't be re-scanned; the run's own detection is then the source (empty for a run analyzed
 * before the form rendered).
 */
export function planFill(
  run: AnalyzedRun,
  scanned: DetectedField[] | null,
  profile: Profile,
): FillPlan {
  // The fresh scan has the right elements; the analyzed run has the right wording and `required`
  // flags (the re-scan path never passes an oracle). `mergeRescan` keeps both.
  const fields = scanned?.length
    ? mergeRescan(scanned, run.jobPageData.fields)
    : run.jobPageData.fields;
  // Resolved through the analyzed run (see `lib/run/answers.ts`), so the panel's warning and this
  // fill agree.
  const drafted = answersFor(run);

  // Questions that mounted after analysis have no answer; they're left blank (and listed in
  // `unresolvedRequiredFields` if required) rather than blocking the fill.
  const values: Record<string, string> = {};
  for (const field of fields) {
    // Every category's disposition is stated in `lib/fieldDisposition.ts`.
    switch (autofillSource(field.category)) {
      case 'question': {
        const answer = drafted.valueFor(field);
        if (answer !== undefined) values[field.id] = answer;
        break;
      }
      case 'profile': {
        const value = valueForCategory(field.category, profile);
        if (value !== undefined) values[field.id] = value;
        break;
      }
      // The resume is attached as a file rather than written as a value; `unsupported` is the
      // recorded decision not to fill this category at all.
      case 'resume':
      case 'unsupported':
        break;
    }
  }

  // Choosing among several resume inputs (Ashby adds an unlabeled decoy) needs the live page, so
  // `content/fillForm.ts` does it; here we only decide whether to render.
  return { fields, values, needsResume: asksForResume(fields) };
}

/**
 * What the page's answer means for the run. `filled` is the page's account of what it kept, or
 * `null` when no frame answered — then counts fall back to what was sent and `fillOutcome` is
 * `unverified`.
 */
export function fillReport(
  plan: FillPlan,
  filled: FillFormResult | null,
  resumeSent: boolean,
): Pick<PipelineRunState, 'unresolvedRequiredFields' | 'filledFieldCount' | 'fillOutcome'> {
  const { fields, values } = plan;
  const isResume = (field: DetectedField) => autofillSource(field.category) === 'resume';
  const resumeFieldIds = new Set(fields.filter(isResume).map((field) => field.id));
  const landed = filled
    ? new Set(filled.filledFieldIds.filter((fieldId) => !resumeFieldIds.has(fieldId)))
    : new Set(Object.keys(values));
  const resumeLanded = filled ? filled.resumeAttached : resumeSent;

  // Unresolved: never drafted, or drafted but not kept by the page (some ATS form models discard
  // programmatic writes).
  const unresolvedRequiredFields = fields.filter(
    (field) => field.required && (isResume(field) ? !resumeLanded : !landed.has(field.id)),
  );

  // What was actually written; an empty unresolved list alone can't tell a perfect fill from an
  // empty form. The attached resume counts as one field.
  const filledFieldCount = landed.size + (resumeLanded ? 1 : 0);

  let fillOutcome: FillOutcome;
  if (fields.length === 0) fillOutcome = 'no-fields-detected';
  else if (filled === null) fillOutcome = 'unverified';
  else if (filledFieldCount === 0) fillOutcome = 'nothing-filled';
  else if (unresolvedRequiredFields.length > 0) fillOutcome = 'incomplete';
  else fillOutcome = 'complete';

  return { unresolvedRequiredFields, filledFieldCount, fillOutcome };
}
