import { z } from 'zod';

/** One job in a profile's work history. */
export const WorkExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.string().describe('e.g. 2022-01'),
  endDate: z.string().nullable().describe('null if current'),
  bullets: z
    .array(z.string())
    .describe("Achievement/responsibility bullet points, in the base profile's own words"),
});
/** Inferred type of {@link WorkExperienceSchema}. */
export type WorkExperience = z.infer<typeof WorkExperienceSchema>;

/** One degree in a profile's education history. */
export const EducationSchema = z.object({
  school: z.string(),
  degree: z.string(),
  field: z.string().nullable(),
  graduationYear: z.string().nullable(),
});
/** Inferred type of {@link EducationSchema}. */
export type Education = z.infer<typeof EducationSchema>;

/**
 * A reusable STAR-format (situation/task/action/result) behavioral or technical anecdote.
 * Drawn on by `answerQuestions` when drafting freeform application answers — `tags` are matched
 * against the question text to pick the most relevant 1-3 stories per question.
 */
export const StorySchema = z.object({
  id: z
    .string()
    .describe('Stable id, e.g. a slug, so answers can reference which story they drew on'),
  title: z
    .string()
    .describe("Short label, e.g. 'Migrated the billing service under a hard deadline'"),
  tags: z
    .array(z.string())
    .describe(
      "Keywords to match against question text, e.g. ['leadership', 'conflict', 'debugging', 'React', 'incident-response']",
    ),
  situation: z.string().describe('Context: what was going on'),
  task: z.string().describe('What needed to be done, and why it was your responsibility'),
  action: z.string().describe('What you specifically did'),
  result: z.string().describe('The outcome, ideally with a concrete metric or impact'),
});
/** Inferred type of {@link StorySchema}. */
export type Story = z.infer<typeof StorySchema>;

/**
 * The whole base profile: contact info, links, work/education history, skills, and reusable
 * stories. Stored whole as the `profiles.data` jsonb column and passed as ground truth into every
 * LLM call — tailoring/answering prompts are instructed never to invent facts outside of it.
 */
export const ProfileSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.object({
    linkedin: z.string().nullable(),
    portfolio: z.string().nullable(),
    github: z.string().nullable(),
  }),
  workExperience: z.array(WorkExperienceSchema),
  education: z.array(EducationSchema),
  skills: z.array(z.string()),
  stories: z
    .array(StorySchema)
    .describe(
      'Reusable STAR-format behavioral/technical anecdotes, drawn on when drafting freeform question answers',
    ),
});
/** Inferred type of {@link ProfileSchema}. */
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Structured job-posting information extracted from scraped page text by `extractJob`
 * (see `apps/backend/src/llm/extractJob.ts`).
 */
export const JobInfoSchema = z.object({
  company: z.string(),
  team: z.string().nullable().describe('Team or department, if mentioned'),
  roleTitle: z.string(),
  seniority: z.string().nullable().describe('e.g. Junior, Senior, Staff'),
  location: z.string().nullable(),
  requirements: z
    .array(z.string())
    .describe('Concrete required/preferred qualifications extracted from the posting'),
  keywords: z
    .array(z.string())
    .describe('Skills/technologies/domain terms worth echoing in a tailored resume'),
});
/** Inferred type of {@link JobInfoSchema}. */
export type JobInfo = z.infer<typeof JobInfoSchema>;

/**
 * A resume tailored to one specific job by `tailorResume`
 * (see `apps/backend/src/llm/tailorResume.ts`). Deliberately a subset of {@link ProfileSchema} —
 * no `education`/`links`, since those don't need per-job tailoring.
 */
export const TailoredResumeSchema = z.object({
  skills: z
    .array(z.string())
    .describe("Subset/reordering of the base profile's skills most relevant to this job"),
  workExperience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      startDate: z.string(),
      endDate: z.string().nullable(),
      bullets: z
        .array(z.string())
        .describe(
          'Reworded/reordered bullets emphasizing relevance to the job; must not invent facts not present in the base profile',
        ),
    }),
  ),
});
/** Inferred type of {@link TailoredResumeSchema}. */
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

/**
 * The categories the (not-yet-built) content script classifies each form field on an ATS page
 * into, before reporting {@link DetectedFieldSchema} entries back to the backend.
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
 */
export const ElementRoleSchema = z.enum(['native', 'combobox', 'radiogroup', 'checkboxgroup']);
/** Inferred type of {@link ElementRoleSchema}. */
export type ElementRole = z.infer<typeof ElementRoleSchema>;

/** One form field found on an ATS application page, classified by the content script. */
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
 * One drafted answer to one detected `question` field, produced by `answerQuestions`
 * (see `apps/backend/src/llm/answerQuestions.ts`).
 */
export const QuestionAnswerSchema = z.object({
  fieldId: z.string().describe('Matches DetectedField.id'),
  question: z.string(),
  answer: z.string(),
  sourceStoryIds: z.array(z.string()).describe('Story.id values this answer drew on, if any'),
});
/** Inferred type of {@link QuestionAnswerSchema}. */
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/** Lifecycle status of an `applications` row. */
export const ApplicationStatusSchema = z.enum(['draft', 'submitted']);
/** Inferred type of {@link ApplicationStatusSchema}. */
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/**
 * One persisted `applications` row: a completed (or in-progress) autofill, keyed to the job
 * posting, so past applications can be referenced later (e.g. by `tailorResume`'s
 * `priorApplicationsSummary`).
 */
export const ApplicationSchema = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  jobUrl: z.string(),
  jobInfo: JobInfoSchema,
  tailoredResume: TailoredResumeSchema,
  answers: z.array(QuestionAnswerSchema),
  status: ApplicationStatusSchema,
  createdAt: z.string(),
});
/** Inferred type of {@link ApplicationSchema}. */
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * Body shape for `POST /applications` — an {@link ApplicationSchema} minus the fields the database
 * assigns (`id`, `createdAt`); `status` defaults to `draft` when omitted, matching a fill that
 * hasn't been submitted yet.
 */
export const NewApplicationSchema = ApplicationSchema.omit({ id: true, createdAt: true }).extend({
  status: ApplicationStatusSchema.default('draft'),
});
/** Inferred type of {@link NewApplicationSchema}. */
export type NewApplication = z.infer<typeof NewApplicationSchema>;
