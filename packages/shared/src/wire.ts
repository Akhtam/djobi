/**
 * The wire contract: one schema per route body, shared by the backend and its clients.
 *
 * zod's `.object()` silently strips unknown keys, so a body restated privately by a route can drop
 * a field the client sends with no error on either side. Sharing one schema turns that drift into a
 * type error.
 */
import { z } from 'zod';
import {
  ApplicationStageSchema,
  ExtractedProfileSchema,
  JobInfoSchema,
  NewNoteSchema,
  NoteSchema,
  ProfileSchema,
  QuestionAnswerSchema,
  ResumeWorkExperienceSchema,
  TailoredResumeSchema,
} from './schemas.js';

/** Safe semantic classifications a backend may expose without leaking provider details. */
export const BackendErrorCodeSchema: z.ZodEnum<{ 'invalid-model-output': 'invalid-model-output' }> =
  z.enum(['invalid-model-output']);
export type BackendErrorCode = z.infer<typeof BackendErrorCodeSchema>;

/** Body of any non-route-specific error raised by `app.onError`. */
export const BackendErrorBodySchema: z.ZodObject<
  { error: z.ZodString; code: z.ZodOptional<typeof BackendErrorCodeSchema> },
  z.core.$strip
> = z.object({
  error: z.string(),
  code: BackendErrorCodeSchema.optional(),
});
/** Inferred type of {@link BackendErrorBodySchema}. */
export type BackendErrorBody = z.infer<typeof BackendErrorBodySchema>;

/**
 * Body of `POST /api/auth/sign-in/email` (a Better Auth route), declared so the dashboard gets a
 * compile error if its request drifts.
 */
export const SignInRequestSchema: z.ZodObject<
  { email: z.ZodEmail; password: z.ZodString },
  z.core.$strip
> = z.object({
  email: z.email(),
  password: z.string().min(1),
});
/** Inferred type of {@link SignInRequestSchema}. */
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/**
 * The fields of Better Auth's sign-in response this app reads. The session itself is the httpOnly
 * cookie the response sets.
 */
export const SignInResultSchema: z.ZodObject<
  { user: z.ZodObject<{ id: z.ZodString; email: z.ZodString }, z.core.$strip> },
  z.core.$strip
> = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
});
/** Inferred type of {@link SignInResultSchema}. */
export type SignInResult = z.infer<typeof SignInResultSchema>;

/** The fields of Better Auth's `POST /api/auth/sign-out` response this app actually reads. */
export const SignOutResultSchema: z.ZodObject<{ success: z.ZodBoolean }, z.core.$strip> = z.object({
  success: z.boolean(),
});
/** Inferred type of {@link SignOutResultSchema}. */
export type SignOutResult = z.infer<typeof SignOutResultSchema>;

/**
 * Body of `POST /api/auth/sign-up/email` (a Better Auth route). `password.min(8)` must match
 * `auth.ts`'s `minPasswordLength` so short passwords fail before the round trip.
 */
export const SignUpRequestSchema: z.ZodObject<
  { email: z.ZodEmail; password: z.ZodString; name: z.ZodString },
  z.core.$strip
> = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().min(1),
});
/** Inferred type of {@link SignUpRequestSchema}. */
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

/** The fields of Better Auth's sign-up response this app reads — see {@link SignInResultSchema}. */
export const SignUpResultSchema: typeof SignInResultSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
});
/** Inferred type of {@link SignUpResultSchema}. */
export type SignUpResult = z.infer<typeof SignUpResultSchema>;

/** A question as detected on the page, before it's known who will answer it. */
export const PendingQuestionSchema: z.ZodObject<
  { fieldId: z.ZodString; question: z.ZodString; options: z.ZodOptional<z.ZodArray<z.ZodString>> },
  z.core.$strip
> = z.object({
  fieldId: z.string(),
  question: z.string(),
  /** Valid choices for a select/combobox/radiogroup/checkboxgroup question, if any. */
  options: z.array(z.string()).optional(),
});
/** Inferred type of {@link PendingQuestionSchema}. */
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

/**
 * A question for the answer-drafting model. `knownAnswer` (from `splitPreparedQuestions`) is a
 * Profile fact the model must map onto this form's wording, not decide — e.g. a stored "No" for
 * sponsorship. The prompt treats it as binding.
 */
export const QuestionForModelSchema: z.ZodObject<
  {
    fieldId: z.ZodString;
    question: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodString>>;
    knownAnswer: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
> = PendingQuestionSchema.extend({
  knownAnswer: z.string().optional(),
});
/** Inferred type of {@link QuestionForModelSchema}. */
export type QuestionForModel = z.infer<typeof QuestionForModelSchema>;

/** Body of `POST /extract-job`. */
export const ExtractJobRequestSchema: z.ZodObject<{ jobDescription: z.ZodString }, z.core.$strip> =
  z.object({
    /** The candidate-reviewed posting text — the Analysis Step's only posting input. */
    jobDescription: z.string().min(1),
  });
/** Inferred type of {@link ExtractJobRequestSchema}. */
export type ExtractJobRequest = z.infer<typeof ExtractJobRequestSchema>;

/** Profile fields that can affect tailored resume content. */
export const TailorResumeProfileSchema: z.ZodObject<
  {
    workExperience: z.ZodArray<
      z.ZodObject<
        {
          company: z.ZodString;
          title: z.ZodString;
          startDate: z.ZodString;
          endDate: z.ZodNullable<z.ZodString>;
          bullets: z.ZodArray<z.ZodString>;
          maxBullets: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
          starredIndices: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
          suppressIfEmpty: z.ZodDefault<z.ZodBoolean>;
        },
        z.core.$strip
      >
    >;
    maxBulletsPerRole: z.ZodDefault<z.ZodNumber>;
    skills: z.ZodArray<z.ZodString>;
  },
  z.core.$strip
> = ProfileSchema.pick({
  workExperience: true,
  maxBulletsPerRole: true,
  skills: true,
});
export type TailorResumeProfile = z.infer<typeof TailorResumeProfileSchema>;

/** Profile fields used to ground drafted Question Answers. */
export const AnswerQuestionsProfileSchema: z.ZodObject<
  {
    education: z.ZodArray<
      z.ZodObject<
        {
          school: z.ZodString;
          degree: z.ZodString;
          field: z.ZodNullable<z.ZodString>;
          graduationYear: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    skills: z.ZodArray<z.ZodString>;
    stories: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          title: z.ZodString;
          tags: z.ZodArray<z.ZodString>;
          situation: z.ZodString;
          task: z.ZodString;
          action: z.ZodString;
          result: z.ZodString;
        },
        z.core.$strip
      >
    >;
    customAnswers: z.ZodDefault<
      z.ZodArray<z.ZodObject<{ question: z.ZodString; answer: z.ZodString }, z.core.$strip>>
    >;
    workExperience: z.ZodArray<typeof ResumeWorkExperienceSchema>;
  },
  z.core.$strip
> = ProfileSchema.pick({
  workExperience: true,
  education: true,
  skills: true,
  stories: true,
  // Prepared answers not matched to a form question, as grounding in the candidate's own words.
  // `screeningAnswers` stays out: legal declarations are never grounding for a draft.
  customAnswers: true,
}).extend({ workExperience: z.array(ResumeWorkExperienceSchema) });
export type AnswerQuestionsProfile = z.infer<typeof AnswerQuestionsProfileSchema>;

/**
 * Profile fields `POST /analyze` sends: the union of {@link TailorResumeProfileSchema} and
 * {@link AnswerQuestionsProfileSchema}, so nothing neither operation uses crosses the wire. Each
 * operation re-parses to its own projection before prompting, so fields one needs (e.g. bullet
 * selection controls) never reach the other's model call.
 */
export const AnalyzeApplicationProfileSchema: z.ZodObject<
  {
    workExperience: z.ZodArray<
      z.ZodObject<
        {
          company: z.ZodString;
          title: z.ZodString;
          startDate: z.ZodString;
          endDate: z.ZodNullable<z.ZodString>;
          bullets: z.ZodArray<z.ZodString>;
          maxBullets: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
          starredIndices: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
          suppressIfEmpty: z.ZodDefault<z.ZodBoolean>;
        },
        z.core.$strip
      >
    >;
    maxBulletsPerRole: z.ZodDefault<z.ZodNumber>;
    education: z.ZodArray<
      z.ZodObject<
        {
          school: z.ZodString;
          degree: z.ZodString;
          field: z.ZodNullable<z.ZodString>;
          graduationYear: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    skills: z.ZodArray<z.ZodString>;
    stories: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          title: z.ZodString;
          tags: z.ZodArray<z.ZodString>;
          situation: z.ZodString;
          task: z.ZodString;
          action: z.ZodString;
          result: z.ZodString;
        },
        z.core.$strip
      >
    >;
    customAnswers: z.ZodDefault<
      z.ZodArray<z.ZodObject<{ question: z.ZodString; answer: z.ZodString }, z.core.$strip>>
    >;
  },
  z.core.$strip
> = ProfileSchema.pick({
  workExperience: true,
  education: true,
  maxBulletsPerRole: true,
  skills: true,
  stories: true,
  customAnswers: true,
});
export type AnalyzeApplicationProfile = z.infer<typeof AnalyzeApplicationProfileSchema>;

/**
 * Body of `POST /analyze`: the whole Analysis Step (extract Job Info, then tailor and answer in
 * parallel) in one round trip. `/extract-job` stays for the Log tab and dashboard; `/tailor-resume`
 * and `/answer-questions` remain only for older extension builds.
 *
 * `questions` is the extension's already-filtered, model-worthy subset.
 */
export const AnalyzeApplicationRequestSchema: z.ZodObject<
  {
    jobDescription: z.ZodString;
    profile: typeof AnalyzeApplicationProfileSchema;
    questions: z.ZodArray<typeof QuestionForModelSchema>;
  },
  z.core.$strip
> = z.object({
  jobDescription: ExtractJobRequestSchema.shape.jobDescription,
  profile: AnalyzeApplicationProfileSchema,
  questions: z.array(QuestionForModelSchema),
});
/** Inferred type of {@link AnalyzeApplicationRequestSchema}. */
export type AnalyzeApplicationRequest = z.infer<typeof AnalyzeApplicationRequestSchema>;

/** Response of `POST /analyze`. */
export const AnalyzeApplicationResponseSchema: z.ZodObject<
  {
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
  },
  z.core.$strip
> = z.object({
  jobInfo: JobInfoSchema,
  tailoredResume: TailoredResumeSchema,
  /** In input-question order, the same output contract `answerQuestions` makes on its own route. */
  answers: z.array(QuestionAnswerSchema),
});
/** Inferred type of {@link AnalyzeApplicationResponseSchema}. */
export type AnalyzeApplicationResponse = z.infer<typeof AnalyzeApplicationResponseSchema>;

/** Profile fields and preferences used to render a PDF. */
export const RenderResumePdfProfileSchema: z.ZodObject<
  {
    fullName: z.ZodString;
    email: z.ZodString;
    phone: z.ZodNullable<z.ZodString>;
    location: z.ZodNullable<z.ZodString>;
    links: z.ZodObject<
      {
        linkedin: z.ZodNullable<z.ZodString>;
        portfolio: z.ZodNullable<z.ZodString>;
        github: z.ZodNullable<z.ZodString>;
      },
      z.core.$strip
    >;
    resumePageSize: z.ZodDefault<z.ZodEnum<{ A4: 'A4'; LETTER: 'LETTER' }>>;
    showRolePrefix: z.ZodDefault<z.ZodBoolean>;
    education: z.ZodArray<
      z.ZodObject<
        {
          school: z.ZodString;
          degree: z.ZodString;
          field: z.ZodNullable<z.ZodString>;
          graduationYear: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
> = ProfileSchema.pick({
  fullName: true,
  email: true,
  phone: true,
  location: true,
  links: true,
  education: true,
  resumePageSize: true,
  showRolePrefix: true,
});
export type RenderResumePdfProfile = z.infer<typeof RenderResumePdfProfileSchema>;

/** Body of `POST /render-resume-pdf`. Responds with PDF bytes, not JSON. */
export const RenderResumePdfRequestSchema: z.ZodObject<
  { profile: typeof RenderResumePdfProfileSchema; tailoredResume: typeof TailoredResumeSchema },
  z.core.$strip
> = z.object({
  profile: RenderResumePdfProfileSchema,
  tailoredResume: TailoredResumeSchema,
});
/** Inferred type of {@link RenderResumePdfRequestSchema}. */
export type RenderResumePdfRequest = z.infer<typeof RenderResumePdfRequestSchema>;

/**
 * Body of `PATCH /applications/:id/stage`. Its own route because `PATCH /applications/:id` takes
 * an `ApplicationSnapshot`, which excludes stage and notes so re-saves can't overwrite tracking.
 */
export const UpdateApplicationStageRequestSchema: z.ZodObject<
  { stage: typeof ApplicationStageSchema },
  z.core.$strip
> = z.object({
  stage: ApplicationStageSchema,
});
/** Inferred type of {@link UpdateApplicationStageRequestSchema}. */
export type UpdateApplicationStageRequest = z.infer<typeof UpdateApplicationStageRequestSchema>;

/** Small acknowledgement returned by compact create and snapshot-update responses. */
export const ApplicationWriteResultSchema: z.ZodObject<{ id: z.ZodString }, z.core.$strip> =
  z.object({ id: z.string() });
export type ApplicationWriteResult = z.infer<typeof ApplicationWriteResultSchema>;

/**
 * The newest matching row's metadata for the Duplicate Guard. `stage` matters: an `onsite` row is
 * a live process; an old `rejected` one may be worth re-applying to.
 */
export const DuplicateApplicationLatestSchema: z.ZodObject<
  {
    id: z.ZodString;
    company: z.ZodString;
    roleTitle: z.ZodString;
    stage: typeof ApplicationStageSchema;
    createdAt: z.ZodString;
  },
  z.core.$strip
> = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  stage: ApplicationStageSchema,
  createdAt: z.string(),
});
export type DuplicateApplicationLatest = z.infer<typeof DuplicateApplicationLatestSchema>;

/** Result of `GET /applications?jobUrl=...&response=compact`, without persisted snapshots. */
export const DuplicateApplicationSummarySchema: z.ZodObject<
  { count: z.ZodNumber; latest: z.ZodNullable<typeof DuplicateApplicationLatestSchema> },
  z.core.$strip
> = z
  .object({
    count: z.number().int().nonnegative(),
    latest: DuplicateApplicationLatestSchema.nullable(),
  })
  .superRefine(({ count, latest }, ctx) => {
    if (count === 0 && latest !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['latest'],
        message: 'latest must be null when count is 0',
      });
    } else if (count > 0 && latest === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['latest'],
        message: 'latest must be non-null when count is greater than 0',
      });
    }
  });
export type DuplicateApplicationSummary = z.infer<typeof DuplicateApplicationSummarySchema>;

/** Authoritative compact result of changing one Application's Stage. */
export const UpdateApplicationStageResultSchema: z.ZodObject<
  { id: z.ZodString; stage: typeof ApplicationStageSchema },
  z.core.$strip
> = z.object({
  id: z.string(),
  stage: ApplicationStageSchema,
});
export type UpdateApplicationStageResult = z.infer<typeof UpdateApplicationStageResultSchema>;

/**
 * Body of `POST /applications/:id/notes`. `id`/`createdAt` are server-assigned, so a client can't
 * choose its own history.
 */
export const AddApplicationNoteRequestSchema: typeof NewNoteSchema = NewNoteSchema;
/** Inferred type of {@link AddApplicationNoteRequestSchema}. */
export type AddApplicationNoteRequest = z.infer<typeof AddApplicationNoteRequestSchema>;

/** Authoritative Note generated by a compact `POST /applications/:id/notes` response. */
export const AddApplicationNoteResultSchema: z.ZodObject<
  { id: z.ZodString; note: typeof NoteSchema },
  z.core.$strip
> = z.object({
  id: z.string(),
  note: NoteSchema,
});
export type AddApplicationNoteResult = z.infer<typeof AddApplicationNoteResultSchema>;

/** Acknowledgement of `DELETE /applications/:id/notes/:noteId`: the removed note's id. */
export const DeleteApplicationNoteResultSchema: z.ZodObject<
  { id: z.ZodString; noteId: z.ZodString },
  z.core.$strip
> = z.object({
  id: z.string(),
  noteId: z.string(),
});
export type DeleteApplicationNoteResult = z.infer<typeof DeleteApplicationNoteResultSchema>;

/** Acknowledgement of `DELETE /applications/:id`: the removed row's id. */
export const DeleteApplicationResultSchema: typeof ApplicationWriteResultSchema = z.object({
  id: z.string(),
});
export type DeleteApplicationResult = z.infer<typeof DeleteApplicationResultSchema>;

/** Body of `POST /profile`: the whole Profile, which the route stores. */
export const SaveProfileRequestSchema: typeof ProfileSchema = ProfileSchema;
/** Inferred type of {@link SaveProfileRequestSchema}. */
export type SaveProfileRequest = z.infer<typeof SaveProfileRequestSchema>;

/**
 * Response of `POST /profile/extract-resume`: a draft the candidate reviews before saving. The
 * request is a multipart upload, so it has no zod schema; the route checks field, size and type.
 */
export const ExtractResumeResponseSchema: typeof ExtractedProfileSchema = ExtractedProfileSchema;
/** Inferred type of {@link ExtractResumeResponseSchema}. */
export type ExtractResumeResponse = z.infer<typeof ExtractResumeResponseSchema>;

/**
 * One turn in an Ask-tab thread. Only `user`/`assistant`: the backend builds the grounding
 * scaffold itself, so a client can't inject a `system` turn.
 */
export const ChatMessageSchema: z.ZodObject<
  { role: z.ZodEnum<{ assistant: 'assistant'; user: 'user' }>; content: z.ZodString },
  z.core.$strip
> = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
/** Inferred type of {@link ChatMessageSchema}. */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Profile fields grounding an answer chat — the same as drafted answers. */
export const AnswerChatProfileSchema: typeof AnswerQuestionsProfileSchema =
  AnswerQuestionsProfileSchema;
export type AnswerChatProfile = z.infer<typeof AnswerChatProfileSchema>;

/**
 * Body of `POST /answer-chat` — every Ask-tab turn. A cold ask has empty `messages` and no
 * `currentAnswer`; a refinement seeds `currentAnswer`. `jobInfo` is optional since the Ask tab
 * works without a run.
 *
 * `messages` must alternate and end with the candidate's turn (it may start with either role).
 * Validating here turns a malformed thread into a 400 instead of an opaque provider error.
 */
export const AnswerChatRequestSchema: z.ZodObject<
  {
    profile: typeof AnswerQuestionsProfileSchema;
    question: z.ZodString;
    jobInfo: z.ZodOptional<typeof JobInfoSchema>;
    currentAnswer: z.ZodOptional<z.ZodString>;
    messages: z.ZodArray<typeof ChatMessageSchema>;
  },
  z.core.$strip
> = z.object({
  profile: AnswerChatProfileSchema,
  /** The application question under discussion. */
  question: z.string().min(1),
  jobInfo: JobInfoSchema.optional(),
  /** The draft being refined, when the thread was seeded from a question card. */
  currentAnswer: z.string().optional(),
  messages: z.array(ChatMessageSchema).superRefine((messages, ctx) => {
    // Checked from the end, because that is where the rule is anchored: the last turn is the one
    // being answered, and everything before it alternates back from there.
    messages.forEach((message, index) => {
      const expected = (messages.length - 1 - index) % 2 === 0 ? 'user' : 'assistant';
      if (message.role !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'role'],
          message: `messages must alternate and end with the user turn being answered; expected ${expected}`,
        });
      }
    });
  }),
});
/** Inferred type of {@link AnswerChatRequestSchema}. */
export type AnswerChatRequest = z.infer<typeof AnswerChatRequestSchema>;

/**
 * Response of `POST /answer-chat`. `reply` is shown in the thread; `revisedAnswer` is what "Use
 * this answer" writes back. A reply may carry no answer, except on a cold turn.
 */
export const AnswerChatResponseSchema: z.ZodObject<
  { reply: z.ZodString; revisedAnswer: z.ZodOptional<z.ZodString> },
  z.core.$strip
> = z.object({
  reply: z.string(),
  revisedAnswer: z.string().optional(),
});
/** Inferred type of {@link AnswerChatResponseSchema}. */
export type AnswerChatResponse = z.infer<typeof AnswerChatResponseSchema>;
