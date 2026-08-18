/**
 * A Detected Field: one thing on a job application page the candidate fills in, and the rules for
 * getting an answer back onto it.
 *
 * The round-trip is the reason this is a module rather than a record. A field is detected in the
 * content script, crosses to the background, is checkpointed into `chrome.storage.session`, sent to
 * the backend, comes back paired with a drafted answer, and is then matched against a *fresh* scan
 * of a page that may have re-rendered in between. Every step has a rule, and each rule used to be
 * explained in a good doc comment in a different file — so answering "why did this answer land in
 * the wrong box" meant reading six of them. The rules live here now:
 *
 * - **Ids are stable across scans.** `detectFields.ts` reuses a `data-djobi-id` it already wrote
 *   rather than reissuing from a counter, because answers are keyed by field id and a counter that
 *   restarts each scan would silently re-point every answer at whichever field now sits in that
 *   position. {@link matchAnswerToField} depends on this holding.
 * - **A choice group is one field, not N.** A fieldset, a `role="radiogroup"`, or radios sharing a
 *   `name` produce a single Detected Field whose `options` are the choices — see
 *   {@link FieldOptionSchema}.
 * - **An option's `selector` may be null**, and then only label matching is possible — see
 *   {@link optionFor}.
 * - **An ambiguous match is no match.** See {@link matchAnswerToField}.
 */
import { z } from 'zod';
import { labelsMatch, uniqueMatch } from './labelMatching.js';

/**
 * The categories the content script classifies each form field on an ATS page into, before
 * reporting {@link DetectedFieldSchema} entries back to the background.
 */
export const FieldCategorySchema = z.enum([
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'location',
  'linkedin_url',
  'portfolio_url',
  'github_url',
  'resume_upload',
  'cover_letter_upload',
  'cover_letter_text',
  'question',
  'unknown',
]);
/** Inferred type of {@link FieldCategorySchema}. */
export type FieldCategory = z.infer<typeof FieldCategorySchema>;

/**
 * How `fillForm.ts` should interact with a field, independent of its semantic `category` —
 * `'native'` covers plain input/textarea/select; the others are ARIA-widget patterns that need
 * click-based interaction instead of setting `.value`.
 *
 * Separate from `category` because the two vary independently: a work-authorization question is the
 * same `question` category whether the ATS renders it as a `<select>` or a react-select combobox,
 * but filling it differs completely.
 */
export const ElementRoleSchema = z.enum(['native', 'combobox', 'radiogroup', 'checkboxgroup']);
/** Inferred type of {@link ElementRoleSchema}. */
export type ElementRole = z.infer<typeof ElementRoleSchema>;

/**
 * One choice on a select/combobox/radiogroup/checkboxgroup {@link DetectedFieldSchema}.
 *
 * `label` is what a candidate reads — it's what the answer-drafting model is shown and constrained
 * to. `selector` is how the Fill Step finds that choice's element again. Keeping the two apart is
 * the whole point: re-deriving a choice's label from the DOM at fill time and hoping it matches the
 * text drafted against is fragile, because every ATS associates option labels differently (a
 * wrapping `<label>`, a `for=`-linked sibling, an `aria-labelledby` reference) and the same element
 * yields different text depending on how you ask.
 */
export const FieldOptionSchema = z.object({
  label: z.string().describe('The choice text a candidate reads — used for prompting and display'),
  selector: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "CSS selector for this choice's element, when one existed at detection time. Null for choices known only from an ATS API schema, or from a listbox that only mounts once opened — those fall back to label matching at fill time.",
    ),
});
/** Inferred type of {@link FieldOptionSchema}. */
export type FieldOption = z.infer<typeof FieldOptionSchema>;

/** One form field found on an ATS application page, classified by the content script. */
export const DetectedFieldSchema = z.object({
  id: z.string().describe('Stable id assigned by the content script for round-tripping'),
  label: z.string().describe('Best-effort human label text for the field'),
  inputType: z.string().describe('input/textarea/select and its type attribute'),
  selector: z
    .string()
    .describe('CSS selector or content-script-internal handle used to locate the element'),
  category: FieldCategorySchema,
  required: z
    .boolean()
    .default(false)
    .describe('Whether the field is marked required (native `required` or `aria-required`)'),
  options: z
    .array(FieldOptionSchema)
    .optional()
    .describe('Available choices for a select/combobox/radiogroup/checkboxgroup field'),
  elementRole: ElementRoleSchema.default('native'),
});
/** Inferred type of {@link DetectedFieldSchema}. */
export type DetectedField = z.infer<typeof DetectedFieldSchema>;

/**
 * Parses a list of Detected Fields that crossed a boundary where the two sides may not be the same
 * build of the extension, dropping any entry that no longer fits the schema.
 *
 * Two boundaries need this and neither had it. `chrome.storage.session` holds entries written by
 * whichever build was running when the tab was opened — an extension reload mid-session leaves the
 * old shape in place. And a content script orphaned by that reload keeps posting the shape *it*
 * knows. In both cases the receiving code read the JSON as if it were current, and a missing
 * `elementRole` or `options[].selector` surfaced later as an unfillable field rather than as a
 * parse failure anyone could trace.
 *
 * Dropping bad entries rather than rejecting the batch is deliberate: one stale field should cost
 * that field, not the whole form. Schema defaults mean a field written before `required` or
 * `elementRole` existed parses cleanly rather than being dropped.
 */
export function parseDetectedFields(value: unknown): DetectedField[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    const parsed = DetectedFieldSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The option on `field` that `answer` names, or `undefined` if it names none.
 *
 * The answer was constrained to one of `field.options` when it was drafted, so matching it back
 * against that same array — rather than re-deriving labels from the DOM — is what closes the
 * round-trip exactly, with no second derivation to disagree with the first.
 */
export function optionFor(field: DetectedField, answer: string): FieldOption | undefined {
  return uniqueMatch(field.options ?? [], (option) => labelsMatch(option.label, answer));
}

/**
 * The answer drafted for `field`, given the labels the Analysis Step saw keyed by the field id it
 * saw them under.
 *
 * By field id first — ids are stable across scans, so this is the normal path. By question text
 * second, for the field that was re-tagged anyway: an element the Analysis Step saw can be unmounted
 * and remounted by the ATS between analyzing and filling (a section expanding, a conditional
 * question re-rendering), which loses its `data-djobi-id` and hands it a new one. The answer was
 * drafted for that *question*, so the question is what identifies it once the id can't.
 *
 * The second path insists the match be unambiguous. Labels are not reliably unique — a form whose
 * labels degrade to a shared placeholder (Ashby renders "Start typing…" on every combobox) gives
 * several fields the same one, and matching the first would put one field's answer into whichever of
 * them happened to be re-tagged. An ambiguous label is no match, leaving the field reported as
 * unresolved rather than confidently filled with the wrong text.
 */
export function matchAnswerToField<TAnswer extends { fieldId: string; answer: string }>(
  field: DetectedField,
  answers: readonly TAnswer[],
  labelByAnalyzedId: ReadonlyMap<string, string>,
): string | undefined {
  const byId = answers.find((answer) => answer.fieldId === field.id);
  if (byId) return byId.answer;

  if (!field.label) return undefined;

  return uniqueMatch(answers, (answer) => {
    const label = labelByAnalyzedId.get(answer.fieldId);
    return label ? labelsMatch(label, field.label) : false;
  })?.answer;
}
