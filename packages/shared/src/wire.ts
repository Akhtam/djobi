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
import {
  ApplicationStageSchema,
  JobInfoSchema,
  NewNoteSchema,
  NoteSchema,
  ProfileSchema,
  ResumeWorkExperienceSchema,
  TailoredResumeSchema,
} from './schemas.js';

/** Safe semantic classifications a backend may expose without leaking provider details. */
export const BackendErrorCodeSchema = z.enum(['invalid-model-output']);
export type BackendErrorCode = z.infer<typeof BackendErrorCodeSchema>;

/** Body of any non-route-specific error raised by `app.onError`. */
export const BackendErrorBodySchema = z.object({
  error: z.string(),
  code: BackendErrorCodeSchema.optional(),
});
/** Inferred type of {@link BackendErrorBodySchema}. */
export type BackendErrorBody = z.infer<typeof BackendErrorBodySchema>;

/**
 * Body of `POST /api/auth/sign-in/email` — Better Auth's own route, not one this backend defines.
 * Named here anyway, the same reasoning as every other route body in this file: the dashboard sends
 * this shape and should get a compile error if it drifts from what Better Auth actually accepts,
 * rather than a silently-stripped field discovered at runtime.
 */
export const SignInRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
/** Inferred type of {@link SignInRequestSchema}. */
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/**
 * The fields of Better Auth's sign-in response this app actually reads. Not the full response
 * shape — Better Auth also returns a `token` and other fields this dashboard has no use for, since
 * the session it acts on lives in the httpOnly cookie the same response sets, not in the body.
 */
export const SignInResultSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
});
/** Inferred type of {@link SignInResultSchema}. */
export type SignInResult = z.infer<typeof SignInResultSchema>;

/** The fields of Better Auth's `POST /api/auth/sign-out` response this app actually reads. */
export const SignOutResultSchema = z.object({ success: z.boolean() });
/** Inferred type of {@link SignOutResultSchema}. */
export type SignOutResult = z.infer<typeof SignOutResultSchema>;

/**
 * Body of `POST /api/auth/sign-up/email` — Better Auth's own route, named here for the same reason
 * {@link SignInRequestSchema} is. `password.min(8)` mirrors `auth.ts`'s `emailAndPassword.
 * minPasswordLength` so a too-short password is rejected client-side before the round trip, not
 * just server-side — the two are pinned to the same number rather than one deriving from the other,
 * since nothing here can import a backend module.
 */
export const SignUpRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});
/** Inferred type of {@link SignUpRequestSchema}. */
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

/** The fields of Better Auth's sign-up response this app actually reads — see {@link SignInResultSchema}. */
export const SignUpResultSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }),
});
/** Inferred type of {@link SignUpResultSchema}. */
export type SignUpResult = z.infer<typeof SignUpResultSchema>;

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
   * The candidate-reviewed posting text from the panel — the Analysis Step's only input.
   * Non-empty: an empty description is a request that can only waste a model call.
   */
  jobDescription: z.string().min(1),
});
/** Inferred type of {@link ExtractJobRequestSchema}. */
export type ExtractJobRequest = z.infer<typeof ExtractJobRequestSchema>;

/** Profile fields that can affect tailored resume content. */
export const TailorResumeProfileSchema = ProfileSchema.pick({
  workExperience: true,
  maxBulletsPerRole: true,
  skills: true,
});
export type TailorResumeProfile = z.infer<typeof TailorResumeProfileSchema>;

/** Body of `POST /tailor-resume`. */
export const TailorResumeRequestSchema = z.object({
  profile: TailorResumeProfileSchema,
  jobInfo: JobInfoSchema,
});
/** Inferred type of {@link TailorResumeRequestSchema}. */
export type TailorResumeRequest = z.infer<typeof TailorResumeRequestSchema>;

/** Profile fields used to ground drafted Question Answers. */
export const AnswerQuestionsProfileSchema = ProfileSchema.pick({
  workExperience: true,
  education: true,
  skills: true,
  stories: true,
  // The candidate's own prepared answers, as grounding for the ones `splitPreparedQuestions` could
  // not match to a question on this form. A stored answer is the candidate's actual position, in
  // their own words, and a model drafting the same question from scratch beside it invents a second
  // one. `screeningAnswers` stays out — those are legal declarations, decided by the matching rules
  // and never grounding for a draft.
  customAnswers: true,
}).extend({ workExperience: z.array(ResumeWorkExperienceSchema) });
export type AnswerQuestionsProfile = z.infer<typeof AnswerQuestionsProfileSchema>;

/** Body of `POST /answer-questions`. */
export const AnswerQuestionsRequestSchema = z.object({
  profile: AnswerQuestionsProfileSchema,
  jobInfo: JobInfoSchema,
  questions: z.array(QuestionForModelSchema),
});
/** Inferred type of {@link AnswerQuestionsRequestSchema}. */
export type AnswerQuestionsRequest = z.infer<typeof AnswerQuestionsRequestSchema>;

/** Profile fields and preferences used to render a PDF. */
export const RenderResumePdfProfileSchema = ProfileSchema.pick({
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
export const RenderResumePdfRequestSchema = z.object({
  profile: RenderResumePdfProfileSchema,
  tailoredResume: TailoredResumeSchema,
});
/** Inferred type of {@link RenderResumePdfRequestSchema}. */
export type RenderResumePdfRequest = z.infer<typeof RenderResumePdfRequestSchema>;

/**
 * Body of `PATCH /applications/:id/stage`.
 *
 * A route of its own rather than a field on `PATCH /applications/:id`, because that one takes an
 * `ApplicationSnapshot` — which deliberately *excludes* stage and notes so a re-save of an autofill
 * can't stomp interview tracking. Moving a stage is a different operation on the same row, and
 * giving it its own path keeps that separation enforceable rather than conventional.
 */
export const UpdateApplicationStageRequestSchema = z.object({
  stage: ApplicationStageSchema,
});
/** Inferred type of {@link UpdateApplicationStageRequestSchema}. */
export type UpdateApplicationStageRequest = z.infer<typeof UpdateApplicationStageRequestSchema>;

/** Small acknowledgement returned by compact create and snapshot-update responses. */
export const ApplicationWriteResultSchema = z.object({ id: z.string() });
export type ApplicationWriteResult = z.infer<typeof ApplicationWriteResultSchema>;

/**
 * The newest row metadata needed by the Duplicate Guard.
 *
 * `stage` rides along because it changes what the notice means: an `onsite` row for this
 * posting is a live process the candidate should not restart, while a `rejected` one from a year
 * ago may well be worth re-applying to. Reporting only the date left the reader to guess which.
 */
export const DuplicateApplicationLatestSchema = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  stage: ApplicationStageSchema,
  createdAt: z.string(),
});
export type DuplicateApplicationLatest = z.infer<typeof DuplicateApplicationLatestSchema>;

/** Result of `GET /applications?jobUrl=...&response=compact`, without persisted snapshots. */
export const DuplicateApplicationSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    latest: DuplicateApplicationLatestSchema.nullable(),
  })
  .superRefine(({ count, latest }, ctx) => {
    if (count === 0 && latest !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latest'],
        message: 'latest must be null when count is 0',
      });
    } else if (count > 0 && latest === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latest'],
        message: 'latest must be non-null when count is greater than 0',
      });
    }
  });
export type DuplicateApplicationSummary = z.infer<typeof DuplicateApplicationSummarySchema>;

/** Authoritative compact result of changing one Application's Stage. */
export const UpdateApplicationStageResultSchema = z.object({
  id: z.string(),
  stage: ApplicationStageSchema,
});
export type UpdateApplicationStageResult = z.infer<typeof UpdateApplicationStageResultSchema>;

/**
 * Body of `POST /applications/:id/notes` — a note minus the fields the server assigns.
 *
 * `NewNoteSchema` rather than a fresh object: `id` and `createdAt` are generated server-side, and
 * accepting them from the client would let a sender choose its own history. Aliased here so this
 * operation-specific transport contract is discoverable even though the shape is already defined.
 */
export const AddApplicationNoteRequestSchema = NewNoteSchema;
/** Inferred type of {@link AddApplicationNoteRequestSchema}. */
export type AddApplicationNoteRequest = z.infer<typeof AddApplicationNoteRequestSchema>;

/** Authoritative Note generated by a compact `POST /applications/:id/notes` response. */
export const AddApplicationNoteResultSchema = z.object({
  id: z.string(),
  note: NoteSchema,
});
export type AddApplicationNoteResult = z.infer<typeof AddApplicationNoteResultSchema>;

/**
 * Body of `POST /profile` — the whole Profile, which is what the route stores.
 *
 * `ProfileSchema` rather than a fresh object, and aliased here for the same reason
 * {@link AddApplicationNoteRequestSchema} is: a reader looking for "what does `/profile` accept"
 * finds the transport contract here rather than inferring it from route implementation details.
 */
export const SaveProfileRequestSchema = ProfileSchema;
/** Inferred type of {@link SaveProfileRequestSchema}. */
export type SaveProfileRequest = z.infer<typeof SaveProfileRequestSchema>;

/**
 * One turn in an answer-chat thread, as the panel holds it and the route replays it.
 *
 * Only the two roles a thread shows: the scaffold the backend builds around them (Profile, Job
 * Info, the question under discussion) is never a message, so a client cannot smuggle a `system`
 * turn — or a rewritten grounding paragraph — past the non-fabrication rules by sending one.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
/** Inferred type of {@link ChatMessageSchema}. */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Profile fields used to ground a chat about one answer — the same grounding as drafted answers. */
export const AnswerChatProfileSchema = AnswerQuestionsProfileSchema;
export type AnswerChatProfile = z.infer<typeof AnswerChatProfileSchema>;

/**
 * Body of `POST /answer-chat` — every turn of the Ask tab, cold ask and refinement alike.
 *
 * The two differ only in what's set here: a cold ask has empty `messages` and no `currentAnswer`;
 * refining an existing draft seeds `currentAnswer` from the question card. The server never
 * branches on which flow it is, which is the point of having one route.
 *
 * `jobInfo` is optional because the Ask tab is reachable with no run at all — a question from a
 * form the extension can't see still gets an answer, grounded in the Profile alone.
 *
 * `messages` is the thread the panel shows, and it is validated as a conversation rather than as a
 * list: the turns alternate, and the last one is the candidate's — the turn this request is asking
 * the model to answer. Nothing is said about the *first* turn's role, because both are real. A
 * seeded thread opens with the candidate's instruction ("make it shorter"); a cold ask's thread
 * opens with the assistant, since the opening user turn there is the backend's own scaffold and
 * never a message. The Messages API rejects two turns of the same role outright, so without this a
 * malformed thread would surface as an opaque provider 500 instead of the 400 it is.
 */
export const AnswerChatRequestSchema = z.object({
  profile: AnswerChatProfileSchema,
  /** The application question under discussion. Non-empty: there is nothing to answer without it. */
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
          code: z.ZodIssueCode.custom,
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
 * Response of `POST /answer-chat`.
 *
 * `reply` is what the thread shows; `revisedAnswer` is what "Use this answer" would write back. A
 * turn may be pure conversation — "which of these two stories do you want?" — so a reply without an
 * answer is a valid outcome, except on a cold turn, where a fresh ask has nothing else to display.
 */
export const AnswerChatResponseSchema = z.object({
  reply: z.string(),
  revisedAnswer: z.string().optional(),
});
/** Inferred type of {@link AnswerChatResponseSchema}. */
export type AnswerChatResponse = z.infer<typeof AnswerChatResponseSchema>;
