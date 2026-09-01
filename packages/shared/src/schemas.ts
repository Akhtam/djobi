import { z } from 'zod';
import { CustomAnswerSchema, ScreeningAnswersSchema } from './screeningAnswers.js';
// Type-only, so these add no runtime import (see the note on `RequirementEvidenceVerdictSchema`
// below) — they exist solely so the compile-time equality checks near each schema's hand-written
// enum can catch the two lists drifting apart.
import type { RequirementEvidenceVerdict } from './requirementEvidence.js';
import type { BulletProvenanceVerdict } from './bulletProvenance.js';

/**
 * Fails to typecheck unless `A` and `B` are the exact same set of literals — used below to keep a
 * schema's hand-written `z.enum([...])` in sync with the TypeScript union it is written to match,
 * without requiring a runtime import between the two modules that each declare one.
 */
type AssertSameLiterals<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/** Resume content shared by a Profile work entry and its projected Tailored Resume entry. */
export const ResumeWorkExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.string().describe('e.g. 2022-01'),
  endDate: z.string().nullable().describe('null if current'),
  bullets: z
    .array(z.string())
    .describe("Achievement/responsibility bullet points, in the base profile's own words"),
});

/** One job in a profile's work history, including its tailoring selection controls. */
export const WorkExperienceSchema = ResumeWorkExperienceSchema.extend({
  maxBullets: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null)
    .describe("Maximum tailored bullets for this role; null inherits the Profile's default"),
  starredIndices: z
    .array(z.number())
    .default([])
    .describe('Indices of source bullets that every tailored resume must include verbatim'),
  suppressIfEmpty: z
    .boolean()
    .default(false)
    .describe(
      'If tailoring selects zero bullets for this role, omit it from the resume entirely instead of showing it empty',
    ),
}).superRefine(({ bullets, starredIndices }, context) => {
  const unique = new Set(starredIndices);
  const allResolve = starredIndices.every(
    (index) => Number.isInteger(index) && index >= 0 && index < bullets.length,
  );

  if (!allResolve || unique.size !== starredIndices.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['starredIndices'],
      message: 'Starred bullet indices must be unique and resolve against bullets',
    });
  }
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
 * stories. Stored whole as the `profiles.data` jsonb column; each operation receives only the
 * projection it uses, and tailoring/answering treat those projected facts as ground truth.
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
  maxBulletsPerRole: z
    .number()
    .int()
    .nonnegative()
    .default(6)
    .describe('Default maximum number of bullets selected for each tailored resume role'),
  resumePageSize: z
    .enum(['A4', 'LETTER'])
    .default('A4')
    .describe('Paper size used when rendering tailored resume PDFs'),
  showRolePrefix: z
    .boolean()
    .default(true)
    .describe('Whether resume role titles are prefixed with "Role:"'),
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
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
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
 * Whether a posting stated a requirement plainly, under its own heading ("Requirements" versus
 * "Nice to have") — or drew no distinction at all. `'unspecified'` is the common case and must not
 * be treated as a fourth kind of `false`: a requirement stored before this field existed lifts to
 * `'unspecified'` rather than `'required'`, since stamping every old row `'required'` would fabricate
 * a fact the posting never stated (see {@link JobInfoSchema}).
 */
export const RequirementKindSchema = z.enum(['required', 'preferred', 'unspecified']);
/** Inferred type of {@link RequirementKindSchema}. */
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

/**
 * One qualification a posting states, with the structure Phase 12's analytics aggregates over.
 * `yearsOfExperience` is null unless the posting states a number — never a guess.
 */
export const JobRequirementSchema = z.object({
  text: z.string().describe("The requirement in the posting's own words"),
  kind: RequirementKindSchema,
  yearsOfExperience: z
    .number()
    .nullable()
    .describe('Years the posting states for this requirement, if any; null otherwise'),
});
/** Inferred type of {@link JobRequirementSchema}. */
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

/**
 * A {@link JobRequirement}, or the bare string every `requirements` row stored before this shape
 * existed — `jobInfo` is jsonb read back exactly as written, so an old row parses through this
 * branch and lifts to `kind: 'unspecified'`, `yearsOfExperience: null`. This is a tolerant *read*,
 * not a migration: nothing rewrites the stored row, and every consumer downstream of
 * {@link JobInfoSchema} sees only the canonical object shape, the same way {@link parseProfile}
 * completes a Profile saved before a field existed.
 */
export const JobRequirementInputSchema = z.union([
  z.string().transform((text): JobRequirement => ({
    text,
    kind: 'unspecified',
    yearsOfExperience: null,
  })),
  JobRequirementSchema,
]);

/**
 * What the Profile/Tailored Resume pair evidences for one requirement — see
 * `requirementEvidence.ts`, the deterministic matcher this shape mirrors. Defined here, not there,
 * because `Application.requirementEvidence` (below) needs it for wire validation and `schemas.ts` is
 * the one module every consumer of a persisted shape already imports; `requirementEvidence.ts` keeps
 * declaring its own `RequirementEvidence`/`RequirementEvidenceVerdict` types as the source of truth
 * for the *function's* return shape, which this schema is written to match structurally rather than
 * be derived from, to avoid a runtime import cycle (that module imports `JobRequirement` from here).
 */
export const RequirementEvidenceVerdictSchema = z.enum([
  'direct-evidence',
  'skill-only',
  'omitted-profile-evidence',
  'needs-confirmation',
  'unsupported',
]);
// No `export type` here: it would collide with `requirementEvidence.ts`'s own
// `RequirementEvidenceVerdict`, which this schema is written to match rather than be inferred
// from — see the doc comment above. Import that one for the type; this file exports only the
// runtime validator.
// If the enum above and `requirementEvidence.ts`'s own union ever drift, this line fails to
// typecheck instead of the schema silently accepting or rejecting values the function can return.
type _RequirementEvidenceVerdictsMatch = AssertSameLiterals<
  z.infer<typeof RequirementEvidenceVerdictSchema>,
  RequirementEvidenceVerdict
>;
const _requirementEvidenceVerdictsMatch: _RequirementEvidenceVerdictsMatch = true;
void _requirementEvidenceVerdictsMatch;

export const RequirementEvidenceSchema = z.object({
  requirement: JobRequirementSchema,
  verdict: RequirementEvidenceVerdictSchema,
  evidence: z.string().nullable(),
});
/** Inferred type of {@link RequirementEvidenceSchema}. */
export type RequirementEvidenceEntry = z.infer<typeof RequirementEvidenceSchema>;

/**
 * The closed set a keyword is categorized into. `'soft-skill'` gets no coverage badge downstream —
 * `keywordCoverage`'s literal match cannot conclude a Profile lacks "leadership" because it says
 * "mentored" instead, and a wrong `missing` verdict is worse than an unscored row.
 */
export const KeywordCategorySchema = z.enum([
  'language',
  'framework',
  'tool',
  'platform',
  'domain',
  'soft-skill',
]);
/** Inferred type of {@link KeywordCategorySchema}. */
export type KeywordCategory = z.infer<typeof KeywordCategorySchema>;

/**
 * One skill/technology/domain term a posting is worth echoing, grouped by {@link KeywordCategory}
 * so "my gaps are all in platform" is a thing analytics can show rather than something the reader
 * has to notice. `category` is null when a term predates categorization or the extractor found no
 * fit — never guessed.
 *
 * `postingSpelling` is the posting's own wording for the same term (`K8s` when `term` is
 * `Kubernetes`) — `null` when a row predates this field or the posting already used the canonical
 * form. It exists to be read, not just kept: `keywordCoverage.ts` matches against it as well as
 * `term`, so a Profile that itself says "K8s" is not reported missing merely because the posting's
 * canonical echo and the Profile's own wording differ.
 */
export const JobKeywordSchema = z.object({
  term: z.string().describe('Canonical, expanded, industry-standard name, e.g. Kubernetes not K8s'),
  category: KeywordCategorySchema.nullable(),
  postingSpelling: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "The posting's own spelling of this term, e.g. K8s; null if it already used the canonical form",
    ),
});
/** Inferred type of {@link JobKeywordSchema}. */
export type JobKeyword = z.infer<typeof JobKeywordSchema>;

/**
 * A {@link JobKeyword}, or the bare string every `keywords` row stored before this shape existed —
 * lifts to `category: null, postingSpelling: null` on read, the same tolerant-read reasoning as
 * {@link JobRequirementInputSchema}.
 */
export const JobKeywordInputSchema = z.union([
  z.string().transform((term): JobKeyword => ({ term, category: null, postingSpelling: null })),
  JobKeywordSchema,
]);

/**
 * Structured job-posting information extracted by `extractJob` from the candidate-reviewed Job
 * Description (see `apps/backend/src/llm/extractJob.ts`).
 */
export const JobInfoSchema = z.object({
  company: z.string(),
  team: z.string().nullable().describe('Team or department, if mentioned'),
  roleTitle: z.string(),
  seniority: z.string().nullable().describe('e.g. Junior, Senior, Staff'),
  location: z.string().nullable(),
  requirements: z
    .array(JobRequirementInputSchema)
    .describe('Concrete required/preferred qualifications extracted from the posting'),
  keywords: z
    .array(JobKeywordInputSchema)
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
    .describe("The base profile's complete skills list, unchanged and in profile order"),
  workExperience: z.array(
    ResumeWorkExperienceSchema.extend({
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
 * The base profile as a {@link TailoredResumeSchema} — the resume with no tailoring applied.
 *
 * This is a projection, not a conversion: selection controls belong to the Profile rather than the
 * resume, while the authored resume content is copied without being reworded, reordered or dropped.
 *
 * Exists for manually logged applications (`source: 'manual'`), where the candidate applied with
 * their own resume and there is no tailored one to store — but the dashboard's detail view renders
 * `Application.tailoredResume` regardless. Storing the base profile keeps it working without a
 * nullable field, and `source` is what tells it which of the two it's looking at.
 *
 * Takes only the two fields it reads, not a whole `Profile` — `tailorResume.ts` calls this against
 * a `TailorResumeProfile` projection (no `fullName`/`email`/…) to build the full, uncapped bullet
 * bank `requirementEvidence.ts` checks Profile-side evidence against, before any model call.
 */
export function baseResumeOf(profile: Pick<Profile, 'skills' | 'workExperience'>): TailoredResume {
  return {
    skills: profile.skills,
    workExperience: profile.workExperience.map(
      ({ company, title, startDate, endDate, bullets }) => ({
        company,
        title,
        startDate,
        endDate,
        bullets,
      }),
    ),
  };
}

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

/**
 * Where an application sits in the interview pipeline. Defaults to `'applied'` rather than being
 * nullable, so nothing downstream has to null-check it. Listed in pipeline order, which is the
 * order a stage picker should offer them in.
 *
 * There used to be a separate `status` field (`draft` / `submitted`) alongside this, meant to
 * answer "was this actually sent to the employer" as distinct from "how far has it got". It was
 * removed because nothing ever set it to `submitted`, so the field carried no information. That
 * does not establish that every saved Application was submitted: there is no authoritative
 * submission event in the current flow. Don't reintroduce a status field without first having a
 * moment in the flow that can set it reliably.
 *
 * The two rejection values are deliberately distinct rather than one `rejected` plus a separate
 * flag. `rejected_ats` means the application never reached a human — screened out before any
 * phone screen — and it sits between `applied` and `phone_screen` because that is where in the
 * pipeline it happens. `rejected` is a rejection after contact was made. Being enum values, the
 * two can't disagree with `stage` the way a parallel boolean could, and the picker offers them
 * without any extra control.
 *
 * What this shape can't record is *which* later stage a `rejected` row came from — the stage it
 * held is overwritten. If that matters, it needs a `rejectedFrom` column, not a third enum value.
 */
export const ApplicationStageSchema = z.enum([
  'applied',
  'rejected_ats',
  'phone_screen',
  'onsite',
  'offer',
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
 * How an application record came to exist. `'autofill'` is a run the extension analyzed, tailored
 * and filled; `'manual'` is one the candidate applied to themselves — uploading a resume by hand or
 * going through LinkedIn Easy Apply — and logged afterwards so it still shows up in the history.
 *
 * A manual entry is a real application, not a lesser one: it carries the same extracted `jobInfo`,
 * and its `tailoredResume` is the base profile projected into that shape rather than an LLM's
 * output. This field exists because those two are otherwise indistinguishable once stored, and the
 * difference matters when reading the history back — "djobi wrote this resume" and "this is just my
 * profile" are not the same claim.
 *
 * Defaults to `'autofill'` at every write boundary, so the extension's existing save path (which
 * posts no `source`) keeps working unchanged.
 */
export const ApplicationSourceSchema = z.enum(['autofill', 'manual']);
/** Inferred type of {@link ApplicationSourceSchema}. */
export type ApplicationSource = z.infer<typeof ApplicationSourceSchema>;

/**
 * The shape `extractJob`/`JobInfoSchema` and `tailorResume`/`TailoredResumeSchema` represent today —
 * stamped onto every `Application` written from this point on (see `NewApplicationSchema`'s default
 * below), so a later extraction or matching change can tell which rows it can safely re-derive
 * provenance for and which predate the fields it reads. Bump it only when the *shape* those two
 * schemas produce changes materially (a Phase 12/13-style widening), not on every prompt wording
 * tweak — this is a compatibility marker, not a build number.
 */
export const EXTRACTION_VERSION = '2026-08-31';

/** {@link BulletProvenanceEntry}'s verdict — mirrors `bulletProvenance.ts`'s own type, see the note on {@link RequirementEvidenceVerdictSchema}. */
export const BulletProvenanceVerdictSchema = z.enum(['verbatim', 'reworded', 'unmatched']);
// If the enum above and `bulletProvenance.ts`'s own union ever drift, this line fails to
// typecheck instead of the schema silently accepting or rejecting values the function can return.
type _BulletProvenanceVerdictsMatch = AssertSameLiterals<
  z.infer<typeof BulletProvenanceVerdictSchema>,
  BulletProvenanceVerdict
>;
const _bulletProvenanceVerdictsMatch: _BulletProvenanceVerdictsMatch = true;
void _bulletProvenanceVerdictsMatch;

/**
 * One Tailored Resume bullet's likely Profile source, with role context — the persisted form of
 * `bulletProvenance.ts`'s per-bullet result, computed once at save time so the audit trail reflects
 * exactly what was saved rather than being re-derivable only while the Profile still matches.
 */
export const BulletProvenanceEntrySchema = z.object({
  company: z.string(),
  title: z.string(),
  bullet: z.string(),
  verdict: BulletProvenanceVerdictSchema,
  source: z.string().nullable(),
});
// No `export type` here either, for the same reason: `bulletProvenance.ts` already exports
// `BulletProvenanceEntry`, and this schema is written to match it rather than be its source.

/**
 * One persisted `applications` row, keyed to the job posting, so its exact generated snapshot
 * remains available in the Dashboard.
 *
 * Either a completed (or in-progress) autofill run, or an application the candidate made by hand
 * and logged afterwards — see {@link ApplicationSourceSchema}. The two are the same record; only
 * `source` and the provenance of `tailoredResume` differ.
 */
export const ApplicationSchema = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  jobUrl: z.string(),
  jobInfo: JobInfoSchema,
  tailoredResume: TailoredResumeSchema,
  answers: z.array(QuestionAnswerSchema),
  source: ApplicationSourceSchema,
  stage: ApplicationStageSchema,
  notes: z.array(NoteSchema),
  /**
   * The posting text as reviewed and analyzed — `extractJob`'s input. `applications` never stored
   * this before; every extraction/matching improvement therefore only ever helped rows saved after
   * it shipped, since there was nothing to re-run it against (see PROGRESS.md's "Known loose ends").
   * `null` for every row saved before this field existed, and for a Log-tab entry whose candidate
   * chose not to keep the posting text.
   */
  rawDescription: z.string().nullable(),
  /** {@link EXTRACTION_VERSION} at the moment this row was written; `null` for rows that predate it. */
  extractionVersion: z.string().nullable(),
  /**
   * `requirementEvidence(tailoredResume, jobInfo, profile)`, computed once at save time against the
   * Profile as it stood then — a later Profile edit does not change what a past application says it
   * evidenced. `null` for a row saved before this field existed, or if the Profile could not be read
   * at save time; never recomputed automatically.
   */
  requirementEvidence: z.array(RequirementEvidenceSchema).nullable(),
  /** `bulletProvenance(tailoredResume, profile)`, computed once at save time — see the field above. */
  bulletProvenance: z.array(BulletProvenanceEntrySchema).nullable(),
  createdAt: z.string(),
});
/** Inferred type of {@link ApplicationSchema}. */
export type Application = z.infer<typeof ApplicationSchema>;

/**
 * Body shape for `POST /applications` — an {@link ApplicationSchema} minus the fields the database
 * assigns (`id`, `createdAt`).
 *
 * `stage` and `notes` default, and must keep doing so: the extension posts a body with neither
 * (`background/applicationPipeline.ts`), so making either required 400s every fill.
 */
export const NewApplicationSchema = ApplicationSchema.omit({ id: true, createdAt: true }).extend({
  // Existing rows may predate URL capture; only reject an invalid URL at the write boundary.
  jobUrl: z.string().url(),
  source: ApplicationSourceSchema.default('autofill'),
  stage: ApplicationStageSchema.default('applied'),
  notes: z.array(NoteSchema).default([]),
  rawDescription: z.string().nullable().default(null),
  // Auto-stamped: a caller never has to know this exists to get an accurate value, the same reason
  // `stage`/`notes` default rather than requiring every existing caller to state them.
  extractionVersion: z.string().nullable().default(EXTRACTION_VERSION),
  requirementEvidence: z.array(RequirementEvidenceSchema).nullable().default(null),
  bulletProvenance: z.array(BulletProvenanceEntrySchema).nullable().default(null),
});
/** Inferred type of {@link NewApplicationSchema}. */
export type NewApplication = z.infer<typeof NewApplicationSchema>;

/**
 * What a client actually *sends* to `POST /applications` — {@link NewApplicationSchema}'s input
 * side, so the three defaulted fields are optional.
 *
 * `NewApplication` is the parsed output, where a default has already been applied and the field is
 * therefore required. Typing a caller against it demands the very fields the defaults exist to let
 * it omit, which is why the extension's save payload didn't typecheck against it.
 */
export type NewApplicationRequest = z.input<typeof NewApplicationSchema>;

/**
 * The editable snapshot of a saved application. Interview tracking belongs to the persisted record,
 * not to the run or the log entry that wrote it, so a re-save must never overwrite its stage or
 * notes.
 *
 * `source` is omitted for the same reason: how a record was created is a fact about the record, not
 * about the snapshot being written over it. Leaving it in would let a re-save relabel a manual entry
 * as an autofill.
 */
export const ApplicationSnapshotSchema = NewApplicationSchema.omit({
  source: true,
  stage: true,
  notes: true,
}).strict();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;
