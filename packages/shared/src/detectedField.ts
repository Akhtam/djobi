/**
 * A Detected Field — one thing on an application page the candidate fills in — and the rules for
 * getting an answer back onto it after it round-trips content script → worker → backend → a fresh
 * scan of a possibly re-rendered page.
 *
 * - **Ids are stable across scans.** `detectFields.ts` reuses an existing `data-djobi-id`, since
 *   answers are keyed by field id.
 * - **A choice group is one field**, with the choices as `options` ({@link FieldOptionSchema}).
 * - **An option's `selector` may be null**; then only label matching works ({@link optionFor}).
 * - **An ambiguous match is no match** ({@link matchAnswerToField}).
 */
import { z } from 'zod';
import { labelsMatch, uniqueMatch } from './labelMatching.js';

/** The categories the content script classifies each form field into. */
export const FieldCategorySchema: z.ZodEnum<{
  cover_letter_text: 'cover_letter_text';
  cover_letter_upload: 'cover_letter_upload';
  email: 'email';
  first_name: 'first_name';
  full_name: 'full_name';
  github_url: 'github_url';
  last_name: 'last_name';
  linkedin_url: 'linkedin_url';
  location: 'location';
  phone: 'phone';
  portfolio_url: 'portfolio_url';
  question: 'question';
  resume_upload: 'resume_upload';
  unknown: 'unknown';
}> = z.enum([
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
 * How `fillForm.ts` interacts with a field: `'native'` sets `.value`; the others are ARIA widgets
 * that need clicks. Independent of `category`: one question may be a `<select>` or a combobox.
 */
export const ElementRoleSchema: z.ZodEnum<{
  checkboxgroup: 'checkboxgroup';
  combobox: 'combobox';
  native: 'native';
  radiogroup: 'radiogroup';
}> = z.enum(['native', 'combobox', 'radiogroup', 'checkboxgroup']);
/** Inferred type of {@link ElementRoleSchema}. */
export type ElementRole = z.infer<typeof ElementRoleSchema>;

/**
 * One choice of a select/combobox/radio/checkbox group. `label` is what the model sees and answers
 * with; `selector` is how the Fill Step finds the element again — so fill never re-derives labels
 * from the DOM, which every ATS labels differently.
 */
export const FieldOptionSchema: z.ZodObject<
  { label: z.ZodString; selector: z.ZodDefault<z.ZodNullable<z.ZodString>> },
  z.core.$strip
> = z.object({
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
export const DetectedFieldSchema: z.ZodObject<
  {
    id: z.ZodString;
    label: z.ZodString;
    inputType: z.ZodString;
    selector: z.ZodString;
    category: typeof FieldCategorySchema;
    required: z.ZodDefault<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodArray<typeof FieldOptionSchema>>;
    elementRole: z.ZodDefault<typeof ElementRoleSchema>;
  },
  z.core.$strip
> = z.object({
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
 * Parses Detected Fields that may come from a different extension build (stale session storage,
 * or an orphaned content script after a reload), dropping entries that no longer fit rather than
 * rejecting the batch. Schema defaults let older-but-compatible entries parse.
 */
export function parseDetectedFields(value: unknown): DetectedField[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    const parsed = DetectedFieldSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The option on `field` that `answer` names. The answer was constrained to `field.options`, so
 * matching against that same array closes the round-trip exactly.
 */
export function optionFor(field: DetectedField, answer: string): FieldOption | undefined {
  return uniqueMatch(field.options ?? [], (option) => labelsMatch(option.label, answer));
}

/**
 * The answer drafted for `field`: by field id first, then by question text for a field the ATS
 * re-mounted (and so re-tagged) between Analysis and Fill.
 *
 * The label fallback requires a unique match — labels can repeat (Ashby puts "Start typing…" on
 * every combobox), and an ambiguous field is better left unresolved than filled wrongly.
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
