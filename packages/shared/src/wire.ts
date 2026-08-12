/**
 * The wire contract between the extension and the local backend: one schema per route body, owned
 * here so both ends derive from the same artifact instead of restating it.
 *
 * Each route used to declare its own body shape inline, next to a domain type in `@djobi/shared`
 * that was *nearly* the same. That is not a cosmetic duplication — zod's `.object()` strips unknown
 * keys, so a field the extension sends and the route's private schema doesn't declare is silently
 * deleted in transit, with no error on either side. It happened: `knownAnswer` was produced by
 * `splitPreparedQuestions`, sent by the Application Pipeline, and dropped by
 * `/answer-questions`'s own `QuestionToAnswerSchema` before `answerQuestions` ever saw it — so the
 * prompt paragraph treating a work-authorization answer as binding fact never ran in production.
 *
 * The failure survived because "a question for the model" had three independent definitions and
 * every test checked one side against its own. Nothing crossed the seam, and the seam was the bug.
 * One schema per body is what makes that class of drift a type error rather than a silent deletion.
 */
import { z } from 'zod';
import { JobInfoSchema, ProfileSchema, TailoredResumeSchema } from './schemas.js';

/** A question as detected on the page, before it's known who will answer it. */
export const PendingQuestionSchema = z.object({
  fieldId: z.string(),
  question: z.string(),
  /** Valid choices for a select/combobox/radiogroup/checkboxgroup question, if any. */
  options: z.array(z.string()).optional(),
});
/** Inferred type of {@link PendingQuestionSchema}. */
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

/**
 * A question for the answer-drafting model, carrying whatever the Profile does know about it.
 *
 * `knownAnswer` is a fact the answer must honor, set by `splitPreparedQuestions` for a question the
 * Profile answers but whose stored wording names none of this form's options unambiguously — a
 * stored "No" against options spelled "I do not require sponsorship now or in the future" /
 * "I will require sponsorship". The decision is already made; only the mapping onto this form's
 * words is left. Getting that backwards on a work-authorization declaration is a misrepresentation,
 * so the prompt treats it as binding rather than as context — which is why it has to survive the
 * trip, and why this schema is shared rather than restated by the route.
 */
export const QuestionForModelSchema = PendingQuestionSchema.extend({
  knownAnswer: z.string().optional(),
});
/** Inferred type of {@link QuestionForModelSchema}. */
export type QuestionForModel = z.infer<typeof QuestionForModelSchema>;

/** Body of `POST /extract-job`. */
export const ExtractJobRequestSchema = z.object({
  /**
   * The posting the candidate pasted into the panel — the Analysis Step's only input.
   * Non-empty: an empty description is a request that can only waste a model call.
   */
  jobDescription: z.string().min(1),
});
/** Inferred type of {@link ExtractJobRequestSchema}. */
export type ExtractJobRequest = z.infer<typeof ExtractJobRequestSchema>;

/**
 * Body of `POST /tailor-resume`.
 *
 * Deliberately no `priorApplicationsSummary`: the route computes it from the `applications` table
 * for `jobInfo.company`. It is a server-side fact, not a client-supplied one.
 */
export const TailorResumeRequestSchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
});
/** Inferred type of {@link TailorResumeRequestSchema}. */
export type TailorResumeRequest = z.infer<typeof TailorResumeRequestSchema>;

/** Body of `POST /answer-questions`. */
export const AnswerQuestionsRequestSchema = z.object({
  profile: ProfileSchema,
  jobInfo: JobInfoSchema,
  questions: z.array(QuestionForModelSchema),
});
/** Inferred type of {@link AnswerQuestionsRequestSchema}. */
export type AnswerQuestionsRequest = z.infer<typeof AnswerQuestionsRequestSchema>;

/** Body of `POST /render-resume-pdf`. Responds with PDF bytes, not JSON. */
export const RenderResumePdfRequestSchema = z.object({
  profile: ProfileSchema,
  tailoredResume: TailoredResumeSchema,
});
/** Inferred type of {@link RenderResumePdfRequestSchema}. */
export type RenderResumePdfRequest = z.infer<typeof RenderResumePdfRequestSchema>;
