import { z } from 'zod';
import { CustomAnswerSchema, ScreeningAnswersSchema } from './screeningAnswers.js';

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
  /**
   * Answers to the screening questions every application asks. Matters of fact with one correct
   * answer, so they're taken from here rather than drafted — see `screeningAnswers.ts`.
   *
   * Optional with an empty default: a profile saved before this field existed is still valid, and
   * `profiles.data` is jsonb read back as-is, so there is no migration to make old rows conform.
   */
  screeningAnswers: ScreeningAnswersSchema.default({}),
  customAnswers: z
    .array(CustomAnswerSchema)
    .default([])
    .describe("Prepared answers to recurring questions the fixed screening topics don't cover"),
});
/** Inferred type of {@link ProfileSchema}. */
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * A Profile with nothing in it — the starting point for a candidate who hasn't filled the form in
 * yet, and the base every partial Profile is completed against by {@link parseProfile}.
 *
 * Lives here, beside the schema it mirrors, because it was previously hand-maintained in the
 * options page: a fourth copy of the Profile's shape, which a field added to the schema had to be
 * remembered into separately.
 *
 * Note the schema deliberately does *not* default these fields. `POST /profile` validates against
 * it, and a route that quietly accepts a body with no `fullName` and stores an empty one is worse
 * than a route that rejects it. Completing a partial Profile is a read-side concern, so it lives in
 * a read-side function rather than in the schema both sides share.
 */
export const EMPTY_PROFILE: Profile = {
  fullName: '',
  email: '',
  phone: null,
  location: null,
  links: { linkedin: null, portfolio: null, github: null },
  workExperience: [],
  education: [],
  skills: [],
  stories: [],
  screeningAnswers: {},
  customAnswers: [],
};

/**
 * Completes a stored Profile against {@link EMPTY_PROFILE} and validates the result.
 *
 * A Profile is read back from jsonb exactly as it was written, so one saved before a field existed
 * comes back without it — and the options form binds straight to those keys
 * (`profile.screeningAnswers[topic]`), so a missing one used to crash the page on render.
 *
 * `links` is merged too, not just replaced. A top-level spread over an empty profile — which is
 * what this replaces — takes a stored `links` object wholesale, so a Profile saved before `github`
 * was added to it kept a `links` with no `github` key and the default never applied. That is the
 * nested case a single spread cannot reach, and the reason this is a function rather than a literal.
 *
 * Falls back to the empty Profile if the merged value still doesn't parse: an unusable stored
 * Profile should leave the candidate with a blank form they can fill in, not a page that won't load.
 */
export function parseProfile(value: unknown): Profile {
  const stored = (value ?? {}) as Partial<Profile>;
  const parsed = ProfileSchema.safeParse({
    ...EMPTY_PROFILE,
    ...stored,
    links: { ...EMPTY_PROFILE.links, ...stored.links },
  });

  return parsed.success ? parsed.data : EMPTY_PROFILE;
}

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
 * One drafted answer to one detected `question` field, produced by `answerQuestions`
 * (see `apps/backend/src/llm/answerQuestions.ts`).
 */
export const QuestionAnswerSchema = z.object({
  fieldId: z.string().describe('Matches DetectedField.id'),
  question: z.string(),
  answer: z.string(),
  /**
   * Defaulted, not required. The model is asked for an empty array when an answer drew on no
   * story, and it routinely omits the key instead — which is the same fact stated by absence.
   * Requiring it made that ordinary omission fatal for the **whole batch**: `callStructured`
   * validates the tool input as one object, so a single missing `sourceStoryIds` failed every
   * answer alongside it and the Analysis Step died with
   * `report_answers produced input that failed validation`.
   *
   * Defaulting also removes the field from the tool's `input_schema.required` and advertises
   * `"default": []` to the model, so omission stops being a contract violation at the source.
   */
  sourceStoryIds: z
    .array(z.string())
    .default([])
    .describe('Story.id values this answer drew on, if any'),
});
/** Inferred type of {@link QuestionAnswerSchema}. */
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/** Lifecycle status of an `applications` row. */
export const ApplicationStatusSchema = z.enum(['draft', 'submitted']);
/** Inferred type of {@link ApplicationStatusSchema}. */
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/**
 * Where an application sits in the interview pipeline. Deliberately separate from
 * {@link ApplicationStatusSchema}: status answers "was this actually sent to the employer", stage
 * answers "how far has it got since". A `draft` application still carries a stage — it defaults to
 * `'applied'` rather than being nullable, so nothing downstream has to null-check it. Listed in
 * pipeline order, which is the order a stage picker should offer them in.
 */
export const ApplicationStageSchema = z.enum([
  'applied',
  'phone_screen',
  'interviewing',
  'rejected',
]);
/** Inferred type of {@link ApplicationStageSchema}. */
export type ApplicationStage = z.infer<typeof ApplicationStageSchema>;

/**
 * How a {@link NoteSchema} entry is filed. Interview questions are split from general notes because
 * that's the split that makes them reusable later — "what did this company ask me technically" is a
 * question you want to answer without re-reading every note on the application.
 */
export const NoteCategorySchema = z.enum(['technical', 'behavioral', 'general']);
/** Inferred type of {@link NoteCategorySchema}. */
export type NoteCategory = z.infer<typeof NoteCategorySchema>;

/**
 * One timestamped entry in an application's notes log — appended, never overwritten, so past
 * interview questions stay around as reference material for future applications.
 *
 * `id` and `createdAt` are assigned by the server on append, never by the client: a note whose
 * timestamp the sender chose isn't trustworthy history.
 */
export const NoteSchema = z.object({
  id: z.string(),
  category: NoteCategorySchema,
  text: z.string(),
  createdAt: z.string(),
});
/** Inferred type of {@link NoteSchema}. */
export type Note = z.infer<typeof NoteSchema>;

/**
 * Body shape for `POST /applications/:id/notes` — a {@link NoteSchema} minus the fields the server
 * assigns. Derived rather than hand-written so it can't drift from `NoteSchema`.
 */
export const NewNoteSchema = NoteSchema.omit({ id: true, createdAt: true });
/** Inferred type of {@link NewNoteSchema}. */
export type NewNote = z.infer<typeof NewNoteSchema>;

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
  stage: ApplicationStageSchema,
  notes: z.array(NoteSchema),
  createdAt: z.string(),
});
/** Inferred type of {@link ApplicationSchema}. */
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * Body shape for `POST /applications` — an {@link ApplicationSchema} minus the fields the database
 * assigns (`id`, `createdAt`); `status` defaults to `draft` when omitted, matching a fill that
 * hasn't been submitted yet.
 *
 * `stage` and `notes` default too, and must keep doing so: the extension posts a body with neither
 * (`background/applicationPipeline.ts`), so making either required 400s every fill.
 */
export const NewApplicationSchema = ApplicationSchema.omit({ id: true, createdAt: true }).extend({
  // Existing rows may predate URL capture; only reject an invalid URL at the write boundary.
  jobUrl: z.string().url(),
  status: ApplicationStatusSchema.default('draft'),
  stage: ApplicationStageSchema.default('applied'),
  notes: z.array(NoteSchema).default([]),
});
/** Inferred type of {@link NewApplicationSchema}. */
export type NewApplication = z.infer<typeof NewApplicationSchema>;

/**
 * The editable snapshot of a saved application. Interview tracking belongs to the persisted record,
 * not the autofill run, so a re-save must never overwrite its stage or notes.
 */
export const ApplicationSnapshotSchema = NewApplicationSchema.omit({
  stage: true,
  notes: true,
}).strict();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;
