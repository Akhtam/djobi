import { z } from 'zod';
import { HttpUrlSchema } from './httpUrl.js';
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
export const ResumeWorkExperienceSchema: z.ZodObject<
  {
    company: z.ZodString;
    title: z.ZodString;
    startDate: z.ZodString;
    endDate: z.ZodNullable<z.ZodString>;
    bullets: z.ZodArray<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  company: z.string(),
  title: z.string(),
  startDate: z.string().describe('e.g. 2022-01'),
  endDate: z.string().nullable().describe('null if current'),
  bullets: z
    .array(z.string())
    .describe("Achievement/responsibility bullet points, in the base profile's own words"),
});

/** One job in a profile's work history, including its tailoring selection controls. */
export const WorkExperienceSchema: z.ZodObject<
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
> = ResumeWorkExperienceSchema.extend({
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
      code: 'custom',
      path: ['starredIndices'],
      message: 'Starred bullet indices must be unique and resolve against bullets',
    });
  }
});
/** Inferred type of {@link WorkExperienceSchema}. */
export type WorkExperience = z.infer<typeof WorkExperienceSchema>;

/** One degree in a profile's education history. */
export const EducationSchema: z.ZodObject<
  {
    school: z.ZodString;
    degree: z.ZodString;
    field: z.ZodNullable<z.ZodString>;
    graduationYear: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
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
export const StorySchema: z.ZodObject<
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
> = z.object({
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
 * One personal, open-source, or freelance project — content a resume routinely carries that has no
 * home on a `workExperience` entry. `bullets` mirrors `workExperience`'s shape rather than folding
 * into `description`, so a project reads the same as a role: one line of context, then detail bullets.
 */
export const ProjectSchema: z.ZodObject<
  {
    name: z.ZodString;
    description: z.ZodString;
    bullets: z.ZodArray<z.ZodString>;
    link: z.ZodNullable<z.ZodString>;
    technologies: z.ZodNullable<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  name: z.string(),
  description: z.string(),
  bullets: z
    .array(z.string())
    .describe("Achievement/detail bullet points, in the base profile's own words"),
  link: z.string().nullable(),
  technologies: z.array(z.string()).nullable(),
});
/** Inferred type of {@link ProjectSchema}. */
export type Project = z.infer<typeof ProjectSchema>;

/** One professional certification. `date` is whatever date the resume names for it — issued or expiring. */
export const CertificationSchema: z.ZodObject<
  { name: z.ZodString; issuer: z.ZodString; date: z.ZodString },
  z.core.$strip
> = z.object({
  name: z.string(),
  issuer: z.string(),
  date: z.string(),
});
/** Inferred type of {@link CertificationSchema}. */
export type Certification = z.infer<typeof CertificationSchema>;

/**
 * One award or honor — a separate shape from {@link CertificationSchema} rather than one combined
 * list, since resumes often bullet the two under one heading but they carry different fields: an
 * award routinely explains itself with a `description`, a certification has no honest use for one.
 */
export const AwardSchema: z.ZodObject<
  {
    name: z.ZodString;
    issuer: z.ZodString;
    date: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  name: z.string(),
  issuer: z.string(),
  date: z.string(),
  description: z.string().optional(),
});
/** Inferred type of {@link AwardSchema}. */
export type Award = z.infer<typeof AwardSchema>;

/**
 * The whole base profile: contact info, links, work/education history, skills, and reusable
 * stories. Stored whole as the `profiles.data` jsonb column; each operation receives only the
 * projection it uses, and tailoring/answering treat those projected facts as ground truth.
 */
export const ProfileSchema: z.ZodObject<
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
    summary: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    workExperience: z.ZodArray<typeof WorkExperienceSchema>;
    maxBulletsPerRole: z.ZodDefault<z.ZodNumber>;
    resumePageSize: z.ZodDefault<z.ZodEnum<{ A4: 'A4'; LETTER: 'LETTER' }>>;
    showRolePrefix: z.ZodDefault<z.ZodBoolean>;
    education: z.ZodArray<typeof EducationSchema>;
    projects: z.ZodDefault<z.ZodArray<typeof ProjectSchema>>;
    certifications: z.ZodDefault<z.ZodArray<typeof CertificationSchema>>;
    awards: z.ZodDefault<z.ZodArray<typeof AwardSchema>>;
    skills: z.ZodArray<z.ZodString>;
    stories: z.ZodArray<typeof StorySchema>;
    screeningAnswers: z.ZodDefault<typeof ScreeningAnswersSchema>;
    customAnswers: z.ZodDefault<z.ZodArray<typeof CustomAnswerSchema>>;
  },
  z.core.$strip
> = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.object({
    linkedin: z.string().nullable(),
    portfolio: z.string().nullable(),
    github: z.string().nullable(),
  }),
  /**
   * Freeform intro paragraph. Optional with a `null` default for the same reason
   * `screeningAnswers`/`customAnswers` below are: a profile saved before this field existed is still
   * valid, and `profiles.data` is jsonb read back as-is.
   */
  summary: z.string().nullable().default(null),
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
  /**
   * Personal/open-source/freelance projects, certifications and awards — all three optional with an
   * empty-array default, same reasoning as `summary` above. Placed after `education`, matching where
   * they read on the resume itself.
   */
  projects: z.array(ProjectSchema).default([]),
  certifications: z.array(CertificationSchema).default([]),
  awards: z.array(AwardSchema).default([]),
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
  summary: null,
  workExperience: [],
  maxBulletsPerRole: 6,
  resumePageSize: 'A4',
  showRolePrefix: true,
  education: [],
  projects: [],
  certifications: [],
  awards: [],
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
 * The Profile fields a resume can honestly supply, as `POST /profile/extract-resume` returns them —
 * see `apps/backend/src/llm/extractResume.ts`. `stories` (STAR-format), `screeningAnswers` and
 * `customAnswers` have no home here: no resume contains that content, so leaving them out is the
 * boundary of what extraction can honestly claim, not a gap. Tailoring-selection controls
 * (`maxBullets`, `starredIndices`, `suppressIfEmpty`) are Profile-only preferences a resume can't
 * state either, so `workExperience` here is {@link ResumeWorkExperienceSchema}-shaped — the same
 * subset {@link TailoredResumeSchema} already uses — rather than the full {@link WorkExperienceSchema}.
 *
 * Every field is nullable or empty-array-friendly, never required: extraction may be partial (a
 * PDF's layout defeats parsing for some section), and "left blank" must mean a null/empty value the
 * candidate can see and fill in themselves, never an invented one. This is deliberately looser than
 * {@link ProfileSchema} itself, which requires `fullName`/`email` — this schema produces a draft the
 * candidate reviews before it can reach the schema that actually enforces those.
 */
export const ExtractedProfileSchema: z.ZodObject<
  {
    fullName: z.ZodNullable<z.ZodString>;
    email: z.ZodNullable<z.ZodString>;
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
    summary: z.ZodNullable<z.ZodString>;
    workExperience: z.ZodArray<typeof ResumeWorkExperienceSchema>;
    education: z.ZodArray<typeof EducationSchema>;
    skills: z.ZodArray<z.ZodString>;
    projects: z.ZodArray<typeof ProjectSchema>;
    certifications: z.ZodArray<typeof CertificationSchema>;
    awards: z.ZodArray<typeof AwardSchema>;
  },
  z.core.$strip
> = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  links: z.object({
    linkedin: z.string().nullable(),
    portfolio: z.string().nullable(),
    github: z.string().nullable(),
  }),
  summary: z.string().nullable(),
  workExperience: z.array(ResumeWorkExperienceSchema),
  education: z.array(EducationSchema),
  skills: z.array(z.string()),
  projects: z.array(ProjectSchema),
  certifications: z.array(CertificationSchema),
  awards: z.array(AwardSchema),
});
/** Inferred type of {@link ExtractedProfileSchema}. */
export type ExtractedProfile = z.infer<typeof ExtractedProfileSchema>;

/**
 * Whether a posting stated a requirement plainly, under its own heading ("Requirements" versus
 * "Nice to have") — or drew no distinction at all. `'unspecified'` is the common case and must not
 * be treated as a fourth kind of `false`: a requirement stored before this field existed lifts to
 * `'unspecified'` rather than `'required'`, since stamping every old row `'required'` would fabricate
 * a fact the posting never stated (see {@link JobInfoSchema}).
 */
export const RequirementKindSchema: z.ZodEnum<{
  preferred: 'preferred';
  required: 'required';
  unspecified: 'unspecified';
}> = z.enum(['required', 'preferred', 'unspecified']);
/** Inferred type of {@link RequirementKindSchema}. */
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

/**
 * How much a requirement matters *in this posting* — never how proficient the candidate is, and
 * never a number. Five bands rather than a 0-100 integer because 101 distinguishable levels is a
 * precision the evidence cannot support: "87" versus "84" will not reproduce across two extractions
 * of the same posting, and a number invites the arithmetic nobody has licensed here — summing
 * importance, averaging it, "% of importance matched". Every other machine-read judgement in this
 * repo is a bounded enum ({@link RequirementKindSchema}, {@link RequirementEvidenceVerdictSchema},
 * {@link KeywordCategorySchema}); this is not the exception.
 *
 * Distinct from `kind`, which records how the *posting phrased* the requirement (under a
 * "Requirements" heading versus a "Nice to have" one). Both are stored: a posting can list a
 * boilerplate line and a screen-deciding must-have under the same heading, which is exactly the
 * distinction `kind` cannot make.
 */
export const RequirementImportanceSchema: z.ZodEnum<{
  critical: 'critical';
  high: 'high';
  'low-signal': 'low-signal';
  meaningful: 'meaningful';
  preferred: 'preferred';
}> = z.enum(['critical', 'high', 'meaningful', 'preferred', 'low-signal']);
/** Inferred type of {@link RequirementImportanceSchema}. */
export type RequirementImportance = z.infer<typeof RequirementImportanceSchema>;

/**
 * The bands in decreasing order of how much they decide an application — the one place that order
 * is written down.
 *
 * Read off the enum rather than retyped, so the sort in `requirementEvidence.ts` and the group
 * order in the dashboard cannot drift from the set of bands or from each other. A band added to the
 * enum lands in this list automatically, at whatever position it was declared, which is why the
 * enum above is itself declared most-decisive-first.
 */
export const IMPORTANCE_BANDS: ('critical' | 'high' | 'low-signal' | 'meaningful' | 'preferred')[] =
  RequirementImportanceSchema.options;

/**
 * Where a requirement's {@link RequirementImportanceSchema} band came from. The band alone is not
 * auditable — this says whether it can be checked against the posting at all, and it is what the
 * cap in `requirementImportance.ts` reads.
 *
 * - `stated` — the posting itself marks it required ("must have", "required", a legal or language
 *   gate, or it appears in the job title). Carries a **verbatim** quote in `postingSignal`.
 * - `structural` — no must-have wording, but the posting's own structure carries the weight: the
 *   section it sits under, repetition across responsibilities, position in the list. Auditable from
 *   the posting text alone, with no market knowledge.
 * - `inferred` — neither; the band is knowledge of how such roles are actually screened. Allowed,
 *   because market weight is genuinely useful and pretending it is unavailable only pushes the guess
 *   underground into an unlabelled band. Labelling it is what makes the cap possible.
 *
 * Deliberately *not* named `RequirementEvidence*`: `requirementEvidence.ts` already owns that word
 * for what the candidate's resume shows, which is a claim about the candidate rather than about the
 * posting. Two `evidence` vocabularies on one screen is a vocabulary nobody can hold.
 */
export const ImportanceTierSchema: z.ZodEnum<{
  inferred: 'inferred';
  stated: 'stated';
  structural: 'structural';
}> = z.enum(['stated', 'structural', 'inferred']);
/** Inferred type of {@link ImportanceTierSchema}. */
export type ImportanceTier = z.infer<typeof ImportanceTierSchema>;

/**
 * One qualification a posting states, with the structure Phase 12's analytics aggregates over.
 * `yearsOfExperience` is null unless the posting states a number — never a guess.
 *
 * `importance`/`importanceTier`/`postingSignal` are all nullable and all default to `null`, so a
 * requirement stored before they existed parses unchanged — `jobInfo` is jsonb read back exactly as
 * written, the same tolerant read {@link JobRequirementInputSchema} performs for a bare string.
 * A `null` band means "not assessed", and it is **not** a sixth band: it must never be counted as a
 * low one, the same way `kind: 'unspecified'` is not a fourth kind of `false`.
 *
 * The schema stays permissive on purpose. The one rule these fields have — that an `inferred` band
 * can never be `critical` or `high` — is enforced by `normalizeRequirementImportance` in
 * `requirementImportance.ts` at extraction time, not by a refinement here. A refinement would make
 * an already-stored row fail to parse, turning a bad extraction into an unreadable application.
 */
export const JobRequirementSchema: z.ZodObject<
  {
    text: z.ZodString;
    kind: typeof RequirementKindSchema;
    yearsOfExperience: z.ZodNullable<z.ZodNumber>;
    importance: z.ZodDefault<z.ZodNullable<typeof RequirementImportanceSchema>>;
    importanceTier: z.ZodDefault<z.ZodNullable<typeof ImportanceTierSchema>>;
    postingSignal: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
  text: z.string().describe("The requirement in the posting's own words"),
  kind: RequirementKindSchema,
  yearsOfExperience: z
    .number()
    .nullable()
    .describe('Years the posting states for this requirement, if any; null otherwise'),
  importance: RequirementImportanceSchema.nullable()
    .default(null)
    .describe('How much this requirement matters in this posting; null if not assessed'),
  importanceTier: ImportanceTierSchema.nullable()
    .default(null)
    .describe('Where the importance band came from; null travels with a null band'),
  postingSignal: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'The posting wording the band rests on: a verbatim quote for stated, a section or repetition reference for structural, null for inferred',
    ),
});
/** Inferred type of {@link JobRequirementSchema}. */
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

/**
 * A {@link JobRequirement}, or the bare string every `requirements` row stored before this shape
 * existed — `jobInfo` is jsonb read back exactly as written, so an old row parses through this
 * branch and lifts to `kind: 'unspecified'` with every later-added field null. This is a tolerant *read*,
 * not a migration: nothing rewrites the stored row, and every consumer downstream of
 * {@link JobInfoSchema} sees only the canonical object shape, the same way {@link parseProfile}
 * completes a Profile saved before a field existed.
 */
export const JobRequirementInputSchema: z.ZodUnion<
  readonly [
    z.ZodPipe<
      z.ZodString,
      z.ZodTransform<
        {
          text: string;
          kind: 'preferred' | 'required' | 'unspecified';
          yearsOfExperience: number | null;
          importance: 'critical' | 'high' | 'low-signal' | 'meaningful' | 'preferred' | null;
          importanceTier: 'inferred' | 'stated' | 'structural' | null;
          postingSignal: string | null;
        },
        string
      >
    >,
    typeof JobRequirementSchema,
  ]
> = z.union([
  z.string().transform((text): JobRequirement => ({
    text,
    kind: 'unspecified',
    yearsOfExperience: null,
    importance: null,
    importanceTier: null,
    postingSignal: null,
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
export const RequirementEvidenceVerdictSchema: z.ZodEnum<{
  'direct-evidence': 'direct-evidence';
  'needs-confirmation': 'needs-confirmation';
  'omitted-profile-evidence': 'omitted-profile-evidence';
  'skill-only': 'skill-only';
  unsupported: 'unsupported';
}> = z.enum([
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

export const RequirementEvidenceSchema: z.ZodObject<
  {
    requirement: typeof JobRequirementSchema;
    verdict: typeof RequirementEvidenceVerdictSchema;
    evidence: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
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
export const KeywordCategorySchema: z.ZodEnum<{
  domain: 'domain';
  framework: 'framework';
  language: 'language';
  platform: 'platform';
  'soft-skill': 'soft-skill';
  tool: 'tool';
}> = z.enum(['language', 'framework', 'tool', 'platform', 'domain', 'soft-skill']);
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
export const JobKeywordSchema: z.ZodObject<
  {
    term: z.ZodString;
    category: z.ZodNullable<typeof KeywordCategorySchema>;
    postingSpelling: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
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
export const JobKeywordInputSchema: z.ZodUnion<
  readonly [
    z.ZodPipe<
      z.ZodString,
      z.ZodTransform<
        {
          term: string;
          category: 'domain' | 'framework' | 'language' | 'platform' | 'soft-skill' | 'tool' | null;
          postingSpelling: string | null;
        },
        string
      >
    >,
    typeof JobKeywordSchema,
  ]
> = z.union([
  z.string().transform((term): JobKeyword => ({ term, category: null, postingSpelling: null })),
  JobKeywordSchema,
]);

/**
 * Structured job-posting information extracted by `extractJob` from the candidate-reviewed Job
 * Description (see `apps/backend/src/llm/extractJob.ts`).
 */
export const JobInfoSchema: z.ZodObject<
  {
    company: z.ZodString;
    team: z.ZodNullable<z.ZodString>;
    roleTitle: z.ZodString;
    seniority: z.ZodNullable<z.ZodString>;
    location: z.ZodNullable<z.ZodString>;
    requirements: z.ZodArray<typeof JobRequirementInputSchema>;
    keywords: z.ZodArray<typeof JobKeywordInputSchema>;
  },
  z.core.$strip
> = z.object({
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
export const TailoredResumeSchema: z.ZodObject<
  {
    skills: z.ZodArray<z.ZodString>;
    workExperience: z.ZodArray<typeof ResumeWorkExperienceSchema>;
  },
  z.core.$strip
> = z.object({
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
export const QuestionAnswerSchema: z.ZodObject<
  {
    fieldId: z.ZodString;
    question: z.ZodString;
    answer: z.ZodString;
    sourceStoryIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
> = z.object({
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
export const ApplicationStageSchema: z.ZodEnum<{
  applied: 'applied';
  offer: 'offer';
  onsite: 'onsite';
  phone_screen: 'phone_screen';
  rejected: 'rejected';
  rejected_ats: 'rejected_ats';
}> = z.enum(['applied', 'rejected_ats', 'phone_screen', 'onsite', 'offer', 'rejected']);
/** Inferred type of {@link ApplicationStageSchema}. */
export type ApplicationStage = z.infer<typeof ApplicationStageSchema>;

/**
 * How a {@link NoteSchema} entry is filed. Interview questions are split from general notes because
 * that's the split that makes them reusable later — "what did this company ask me technically" is a
 * question you want to answer without re-reading every note on the application.
 */
export const NoteCategorySchema: z.ZodEnum<{
  behavioral: 'behavioral';
  general: 'general';
  technical: 'technical';
}> = z.enum(['technical', 'behavioral', 'general']);
/** Inferred type of {@link NoteCategorySchema}. */
export type NoteCategory = z.infer<typeof NoteCategorySchema>;

/**
 * One timestamped entry in an application's notes log — appended, never overwritten, so past
 * interview questions stay around as reference material for future applications.
 *
 * `id` and `createdAt` are assigned by the server on append, never by the client: a note whose
 * timestamp the sender chose isn't trustworthy history.
 */
export const NoteSchema: z.ZodObject<
  {
    id: z.ZodString;
    category: typeof NoteCategorySchema;
    text: z.ZodString;
    createdAt: z.ZodString;
  },
  z.core.$strip
> = z.object({
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
export const NewNoteSchema: z.ZodObject<
  { category: typeof NoteCategorySchema; text: z.ZodString },
  z.core.$strip
> = NoteSchema.omit({ id: true, createdAt: true });
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
export const ApplicationSourceSchema: z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }> =
  z.enum(['autofill', 'manual']);
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
export const EXTRACTION_VERSION = '2026-09-10';

/** {@link BulletProvenanceEntry}'s verdict — mirrors `bulletProvenance.ts`'s own type, see the note on {@link RequirementEvidenceVerdictSchema}. */
export const BulletProvenanceVerdictSchema: z.ZodEnum<{
  reworded: 'reworded';
  unmatched: 'unmatched';
  verbatim: 'verbatim';
}> = z.enum(['verbatim', 'reworded', 'unmatched']);
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
export const BulletProvenanceEntrySchema: z.ZodObject<
  {
    company: z.ZodString;
    title: z.ZodString;
    bullet: z.ZodString;
    verdict: typeof BulletProvenanceVerdictSchema;
    source: z.ZodNullable<z.ZodString>;
  },
  z.core.$strip
> = z.object({
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
export const ApplicationSchema: z.ZodObject<
  {
    id: z.ZodString;
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobUrl: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    source: z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }>;
    stage: typeof ApplicationStageSchema;
    notes: z.ZodArray<typeof NoteSchema>;
    rawDescription: z.ZodNullable<z.ZodString>;
    extractionVersion: z.ZodNullable<z.ZodString>;
    requirementEvidence: z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>;
    bulletProvenance: z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>;
    createdAt: z.ZodString;
  },
  z.core.$strip
> = z.object({
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
export const NewApplicationSchema: z.ZodObject<
  {
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    jobUrl: z.ZodURL;
    source: z.ZodDefault<z.ZodEnum<{ autofill: 'autofill'; manual: 'manual' }>>;
    stage: z.ZodDefault<typeof ApplicationStageSchema>;
    notes: z.ZodDefault<z.ZodArray<typeof NoteSchema>>;
    rawDescription: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extractionVersion: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    requirementEvidence: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>>;
    bulletProvenance: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>>;
  },
  z.core.$strip
> = ApplicationSchema.omit({ id: true, createdAt: true }).extend({
  // Existing rows may predate URL capture; only reject an invalid URL at the write boundary.
  //
  // `HttpUrlSchema`, not `z.string().url()`: zod's `.url()` is `new URL(value)` in a try/catch, so
  // it accepts `javascript:alert(1)` as readily as `https://…`. A stored `jobUrl` is rendered as an
  // `<a href>` by the dashboard's `PostingLink`, which made a non-http scheme reaching this column a
  // script URL one click away from running on the dashboard's own origin. See `httpUrl.ts`.
  jobUrl: HttpUrlSchema,
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
export const ApplicationSnapshotSchema: z.ZodObject<
  {
    company: z.ZodString;
    roleTitle: z.ZodString;
    jobInfo: typeof JobInfoSchema;
    tailoredResume: typeof TailoredResumeSchema;
    answers: z.ZodArray<typeof QuestionAnswerSchema>;
    jobUrl: z.ZodURL;
    rawDescription: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    extractionVersion: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    requirementEvidence: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof RequirementEvidenceSchema>>>;
    bulletProvenance: z.ZodDefault<z.ZodNullable<z.ZodArray<typeof BulletProvenanceEntrySchema>>>;
  },
  z.core.$strict
> = NewApplicationSchema.omit({
  source: true,
  stage: true,
  notes: true,
}).strict();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;
